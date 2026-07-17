# Verification & Metrics Plan

Companion to [DESIGN.md](./DESIGN.md) §7. This repo doubles as the test
harness; the implementation work happens in the upstream clones.

## 1. Which codebases the work targets

| Phase | Repo | Key files touched |
|---|---|---|
| 1 | [`holepunchto/dht-rpc`](https://github.com/holepunchto/dht-rpc) → `upstream/dht-rpc` | `lib/peer.js` (ipv6 codec, `id6`), `lib/io.js` (v6 socket pair, 18-byte `to`, `validateId6`, v6 `closerNodes`), `index.js` (`families` option, `table6`/`nodes6`, per-prefix caps, family-routed `addNode`) |
| 2 | [`holepunchto/hyperdht`](https://github.com/holepunchto/hyperdht) → `upstream/hyperdht` | `lib/connect.js` (stop hard-coding `addresses6: []`, family race), `lib/messages.js` (capability echo) — revives closed PR [#101](https://github.com/holepunchto/hyperdht/pull/101) |
| 3 | `hyperdht` | `lib/holepuncher.js` (v6 simultaneous-open strategy), `lib/messages.js` (relay/holepunch v6 flags per DESIGN.md §5.5 table), `lib/announcer.js` (announce on both DHTs) |
| 4 | [`holepunchto/hyperswarm`](https://github.com/holepunchto/hyperswarm) + bootstrap ops | surface `families`, docs, AAAA records |

Setup: `npm run setup` (clones both repos into `upstream/` and installs).
`upstream/` is gitignored — it is a workbench, not vendored code. Phase 1
changes are made directly in `upstream/dht-rpc` and later become the PR
branch against the fork.

## 2. Test suites in this repo

```
test/phase1/
  01-v4-golden.test.js     GREEN pin — v4 wire bytes, id derivation, live ping
  02-ipv6-codec.test.js    RED — peer.ipv6 / ipv6Array (DESIGN §5.2)
  03-id6.test.js           RED — masked /64 id derivation (DESIGN §5.3)
  04-table-caps.test.js    RED — per-/64 and per-/48 caps, family isolation
  05-sockets.test.js       RED — families option, dual bind, safe demotion (§5.1/§5.4)
  06-integration.test.js   RED — mixed-family swarm matrix over ::1 (§7)
```

- `npm run test:golden` — must pass **before and after every change**. These
  fixtures were generated from unmodified `dht-rpc@6.27.0` and are never
  regenerated; a failure means the v4 network contract broke (DESIGN goal 1).
- `npm run test:red` — the Phase 1 TDD contract. All red today by design;
  Phase 1 is done when this is green **and** the golden suite is still green.
- The proposed public API these tests pin (`families`, `host6`, `address6()`,
  `table6`, `host6` getter) is a draft contract — adjust alongside maintainer
  feedback on DESIGN.md §8, then update the tests first, code second.

## 3. Verification procedure (definition of done, per phase)

### Phase 1 (`dht-rpc`)

1. `npm run test:golden` — green (byte-level v4 pin).
2. Upstream's own suite untouched: `cd upstream/dht-rpc && npm test`
   (runs both `brittle-node` and `brittle-bare`) — green with **zero diff to
   test.js**, proving no behavioral change for v4-only users.
3. `npm run test:red` — green.
4. Negative check: run golden suite against the patched tree with
   `families: ['ipv4']` default — a v4-only node must never open a v6 socket
   (asserted in `05-sockets` test 1).
5. CI matrix: Node + Bare, macOS/Linux/Windows runners (loopback `::1` works
   on all GitHub runners), plus one job that adds a ULA address
   (`fd00::/8`) to exercise multi-address selection.

### Phase 2–3 (`hyperdht`)

1. Upstream suite green unmodified (`cd upstream/hyperdht && npm test`).
2. Extend `testnet.js` helper with `families` and add the connection matrix:
   - v4-only ↔ v4-only: unchanged (golden).
   - dual ↔ v6-only, v6-only ↔ dual: connects, `stream.rawStream.remoteFamily === 6`.
   - v6-only ↔ v4-only: fails with a clean error, documented.
   - dual ↔ dual: family race yields **exactly one** connection per
     `remotePublicKey` (assert pool size and no duplicate `connection` events).
   - Chaos: destroy the v6 socket mid-race → v4 fallback completes.
3. Strict-decoder safety: golden `noisePayload` fixtures proving new flags
   are only emitted to peers that advertised v6 (capability echo, §5.5).

### Phase 4 / testnet

- 3 dual-stack public nodes (per DESIGN §5.7); verify a v6-only VPS and a
  v4-only host both bootstrap from the same hostnames (AAAA + A).

## 4. Metrics: what to gather and how

### Already in the codebase (extend per family)

`dht-rpc` exposes `dht.stats` today (`lib/io.js`): request counts,
responses, timeouts, retries, per-command tx/rx, plus `lib/health.js`
(timeout-rate window). Phase 1 splits these per family:

```js
dht.stats.requests            // v4 (unchanged shape)
dht.stats.requests6           // same shape, v6 sockets
// per-family timeout rates are derived from these counters
// (see scripts/testnet/stats-logger.js)
```

### Implementation-quality metrics (harness / CI)

| Metric | Source | Gate |
|---|---|---|
| v4 wire regression | golden suite | 0 failures, always |
| Upstream suite pass rate | `npm test` in both clones | 100%, node + bare |
| Coverage of new code paths | `brittle --coverage` | ≥ 80% on changed lines |
| Routing-table cap enforcement | `04-table-caps` | ≤1 per /64, ≤8 per /48 |

### Network-behavior metrics (testnet, Phases 2–4)

| Metric | How measured | Success signal |
|---|---|---|
| Time-to-connect per family | timestamp around `dht.connect()` in matrix tests; report p50/p95 | v6 direct ≤ v4 holepunch p50 |
| Connection outcome mix | classify each connection: `direct-v6 / direct-v4 / holepunch-v4 / relayed` (from `stream.rawStream.remoteFamily` + puncher state) | relayed share drops for dual-stack pairs |
| Family-race duplicate attempts | count discarded losing streams per connection | duplicates discarded 100%, connections per key = 1 |
| Holepunch success rate v4 vs v6 simultaneous-open | puncher outcome codes on testnet nodes | v6 ≥ v4 on dual-stack pairs |
| DHT query latency per family | `res.rtt` already returned by `lib/io.js` | v6 within 10% of v4 on same hosts |
| Bootstrap reachability | cron probe: v6-only client resolves AAAA and joins | 100% over 7 days before default flip |

Gathering: testnet nodes run with a small stats logger (poll `dht.stats` +
connection outcomes every 60s to JSONL); the matrix tests print the same
fields in CI so trends are visible per PR. No new telemetry protocol —
everything reads existing counters.

### Rollout gates (DESIGN §6)

- Phase N merges only with: golden green, upstream suite green, phase suite
  green, coverage gate met.
- Default `families` flip (Phase 4) additionally requires 7 days of testnet
  bootstrap reachability at 100% and no v4 regression reports.
