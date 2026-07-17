# Implementation Plan: Phases 1–4

Execution plan for [DESIGN.md](./DESIGN.md), verified by [VERIFICATION.md](./VERIFICATION.md).
Every workstream is test-first: the contract suite is written (or already
exists) before the code, and no phase merges unless the golden v4 pins and
the upstream suites stay green.

## Standing rules

1. **Golden gate**: `npm run test:golden` green before and after every change. A red golden suite reverts the change, no exceptions.
2. **Upstream gate**: `npm test` in the touched upstream repo (node **and** bare runtimes) green with zero modifications to its existing test files.
3. **Test-first**: each workstream starts by making/extending a RED contract suite in `test/phaseN/`, then implements until green.
4. **Branch strategy**: work on fork branches `AdebayoGit/dht-rpc#ipv6-phase1`, `AdebayoGit/hyperdht#ipv6-phase2`, `#ipv6-phase3`, `AdebayoGit/hyperswarm#ipv6-phase4`. One PR per phase, stacked only where unavoidable (Phase 3 stacks on 2).
5. **Maintainer feedback is non-blocking but steering**: post ISSUE-COMMENT.md to hyperdht#1 at the start. If answers to DESIGN §8 arrive (id6 derivation choice, API naming, capability echo vs version bump), update tests first, code second. Until then, build the draft contract as pinned (simple `id6`, `families`/`host6`/`address6()`/`table6`).

## Workstream 0 — Preflight (½ day)

- [ ] Post ISSUE-COMMENT.md to holepunchto/hyperdht#1; push this repo (design + harness) so the comment's link resolves.
- [ ] Fork `dht-rpc`, `hyperdht`, `hyperswarm`; point `upstream/` clones' `origin` at the forks, add `upstream` remotes.
- [ ] CI skeleton in the fork: GitHub Actions matrix — {ubuntu, macos, windows} × {node, bare}, plus one ubuntu job that adds a ULA address (`sudo ip addr add fd00::1/64 dev lo`) for multi-address tests.

## Phase 1 — `dht-rpc` (contract exists: `test/phase1/02–06`, 22 RED tests)

Target: all RED green, golden green, upstream suite green. Est. 3–5 days.

| Step | File | Work | Proves |
|---|---|---|---|
| 1.1 | `lib/peer.js` | `ipv6` codec (wrap `c.ipv6Address`, inject `id: null`), `ipv6Array`, `id6(host, port)` = blake2b over 10 bytes (masked /64 prefix ‖ LE port) | `02`, `03` suites |
| 1.2 | `lib/io.js` | Parameterize IO by family: `addrCodec`, `addrSize` (6→18), `id`/`validateId` fn, bind host default (`0.0.0.0` vs `::`). No v4 byte changes — header math stays `1+1+addrSize+2` | golden + `02` |
| 1.3 | `index.js` | `families` option (default `['ipv4']`), second IO + `table6`/`nodes6` when `ipv6` enabled, `host6` option + getter, `address6()`, family-routed `addNode` (via `UDX.isIPv6`), v6 `nat-sampler` instance for external-address learning | `05`, `06` |
| 1.4 | `index.js` `_addNode` | Per-prefix caps at insert: ≤1 entry per /64, ≤8 per /48 (count maps keyed on masked prefixes, decrement on eviction/removal) | `04` |
| 1.5 | `index.js` bootstrap | Resolve A + AAAA; route each result to its family's table; accept `[v6]:port` literals; v6 bind failure demotes to v4-only with a warning instead of throwing | `05` demotion, `06` join |
| 1.6 | stats | Split `dht.stats` per family (`requests6`, per-command tx/rx on the v6 IO); keep v4 shape identical | VERIFICATION §4 |

Exit: `npm run test:red` 26/26, `npm run test:golden` 4/4, upstream `npm test` green on the CI matrix, coverage ≥80% on changed lines. Open PR 1.

## Phase 2 — `hyperdht` address exchange + race (revives PR #101)

Est. 4–6 days. **Write `test/phase2/` first** (~1 day):

- `01-noise-golden.test.js` — GREEN pins: `noisePayload` byte fixtures from unmodified hyperdht; a v4-only handshake never contains v6 flags.
- `02-capability-echo.test.js` — v6 fields only sent to peers that advertised v6; strict decoder fed a v4-era payload parses cleanly.
- `03-connect-race.test.js` — testnet matrix: dual↔v6-only connects (`rawStream.remoteFamily === 6`); dual↔dual race yields exactly one connection per `remotePublicKey`; v6-only↔v4-only fails with a clean error.
- `04-chaos.test.js` — kill v6 socket mid-race, v4 fallback completes.

Then implement:

| Step | File | Work |
|---|---|---|
| 2.1 | `lib/messages.js` | Capability echo: record whether the peer's `noisePayload` carried v6; gate all new flags on it |
| 2.2 | `lib/connect.js` | Stop hard-coding `addresses6: []`; populate from v6 DHT's echoed `to` + non-deprecated local v6 addrs (`isBogon` already v6-aware) |
| 2.3 | `lib/connect.js` | Family race, Happy-Eyeballs style: direct v6 attempt with ~150 ms head start vs the v4 holepunch flow; first stream wins at the existing `onsocket` claim point |
| 2.4 | `testnet.js` | `families` support so mixed populations can be spun up in tests |
| 2.5 | Pass Phase-1 `families` through hyperdht's DHT constructor to dht-rpc |

Exit: phase2 suite green, hyperdht upstream suite green, noise golden pins green. Open PR 2 (depends on published/linked Phase 1).

## Phase 3 — `hyperdht` v6 simultaneous-open, relay, announce

Est. 4–6 days. **Write `test/phase3/` first**: simultaneous-open connects two firewalled-but-global-v6 testnet nodes without relay; announce on both DHTs is found by v4-only AND v6-only lookups; relay fields round-trip; v4-era decoder never sees the new flags (golden).

| Step | File | Work |
|---|---|---|
| 3.1 | `lib/holepuncher.js` | New puncher strategy: when both sides advertised global v6, short-circuit `probeRound` into stateless simultaneous open (no rebind analysis, no `FIREWALL.RANDOM`) |
| 3.2 | `lib/messages.js` | `holepunchPayload.addresses6` (flag 64), `noisePayload.relayAddresses6` (flag 128), `handshake.peerAddress6`/`relayAddress6` (flags 4, 8), `relayInfo` v6 variant versioned by `noisePayload.version` — all behind the Phase-2 capability echo |
| 3.3 | `lib/announcer.js` + `lib/server.js` | Dual-stack servers announce the same signed record on both DHTs; v6-DHT records use `ipv6Array`; `peer.relayAddresses` stays v4 on the v4 DHT |
| 3.4 | Router/relay | Verify `relayThrough` with a dual-stack relay bridges v4-only↔v6-only at the connection layer (documented path, add test) |

Exit: phase3 suite green, all prior gates green. Open PR 3 (stacked on PR 2).

## Phase 4 — surface, infra, metrics, flip

Est. 2–3 days code + 1–2 weeks soak. Parallel tracks:

**4a. `hyperswarm` surface**: pass `families` through Hyperswarm's constructor to hyperdht; docs for all three repos; `test/phase4/` — swarm-level dual↔v6-only topic join.

**4b. Public testnet + metrics**: deploy 3 dual-stack nodes (v6-capable VPSes); each runs the stats logger (poll `dht.stats`/connection outcomes → JSONL, per VERIFICATION §4); publish reachability probe (cron: v6-only client joins via AAAA) with results in this repo.

**4c. Bootstrap ops**: request AAAA records + v6 listeners on the official bootstrap hostnames (Holepunch ops — external dependency; testnet nodes serve as interim bootstrap for reviewers).

**4d. Default flip proposal**: after 7 days of 100% testnet bootstrap reachability and no v4 regressions, open the one-line `families: ['ipv4','ipv6']` default PR with the soak data attached.

Exit: docs merged, testnet public and measured, flip PR opened with evidence.

## Parallelization map

- Phase 1 steps 1.1 (codecs/id6) and 1.4 (caps) are independent — two agents can build them concurrently; 1.2/1.3 serialize (both touch IO wiring).
- Phase 2 test-writing can start while Phase 1 is under review (testnet helper work is hyperdht-side).
- Phase 4b (testnet infra) can start as soon as Phase 1 lands — a dht-rpc-only v6 testnet already exercises routing.
- Reviews: run code-review + security-review agents per phase before opening each PR (eclipse-resistance focus on 1.4, decoder-safety focus on 2.1/3.2).

## Risks

| Risk | Mitigation |
|---|---|
| Maintainers prefer BEP 42 hybrid `id6` or different API names | Only `03-id6` spec test + option names change; masking properties and caps tests survive both. Tests first, then a mechanical rename |
| No maintainer response | Everything proceeds on forks + our testnet; PRs stay open with evidence attached |
| GitHub runners lack global v6 | All CI uses `::1` + ULA job; global-v6 behavior verified on the testnet instead |
| Bare runtime divergence (`bare-events`, udx bindings) | CI matrix runs bare from Phase 1 day one |
| `#101`'s unknown blocker resurfaces in Phase 2 | First Phase-2 step is re-reading #101's diff + review thread; its lessons are folded into the phase2 contract before coding |
| Same-/64 honest ID collision (simple `id6`) | Documented; switch to hybrid is a contained change if maintainers prefer (§5.3) |

## Definition of done (whole effort)

All four PRs open (1 mergeable independently, 2–3 stacked, 4 trivial), golden + upstream + phase suites green across the CI matrix, public testnet running with ≥7 days of published metrics, and the default-flip PR ready with soak evidence.
