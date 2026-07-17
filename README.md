# hyperdht-ipv6

A design proposal for adding **IPv6 support to the Hyperswarm stack** (`dht-rpc` + `hyperdht`), addressing [holepunchto/hyperdht#1](https://github.com/holepunchto/hyperdht/issues/1) — open since 2018.

**→ Read the full design: [DESIGN.md](./DESIGN.md)**

## TL;DR

- **Family-isolated parallel DHT** (the [BEP 32](https://www.bittorrent.org/beps/bep_0032.html) architecture): IPv4 wire messages stay byte-for-byte unchanged — zero risk to the production network.
- **/64-masked node IDs** ([BEP 42](https://www.bittorrent.org/beps/bep_0042.html)-style) so IPv6's cheap address space doesn't gift attackers eclipse capacity.
- **Dedup on the Noise public key** — connection identity machinery that already exists in `hyperdht` answers the duplicate-address concern from the original issue.
- **The stack is closer than it looks**: `libudx` already speaks IPv6, and `hyperdht`'s `noisePayload` has carried a reserved `addresses6` field all along — this proposal completes existing intent.
- **Four independent phases**, each shippable behind a `families` option with no network flag day.

## Why

IPv6-only networks (meshnets, mobile carriers without 464XLAT, v6-only VPSes) cannot reach the DHT at all today. And where both peers hold global IPv6 addresses, holepunching collapses into a simple simultaneous open — no NAT rebind heuristics, no `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, fewer relay fallbacks — precisely on the networks where IPv4 punching is weakest.

## Test harness

This repo is also the TDD harness for the implementation ([VERIFICATION.md](./VERIFICATION.md)):

```bash
npm run setup        # clones dht-rpc + hyperdht into upstream/ and installs
npm run test:golden  # v4 wire-format regression pins — green today, must stay green
npm run test:red     # Phase 1 contract (codecs, id6, caps, sockets, integration) — green when Phase 1 is done
```

## Status

- [x] Design draft
- [x] Phase 1 test contract + v4 golden regression pins ([test/phase1](./test/phase1), [VERIFICATION.md](./VERIFICATION.md))
- [ ] Maintainer feedback ([hyperdht#1](https://github.com/holepunchto/hyperdht/issues/1))
- [ ] Phase 1: `dht-rpc` — v6 codecs, masked IDs, dual sockets, per-family tables
- [ ] Phase 2: `hyperdht` — populate `addresses6`, capability echo, direct-connect race
- [ ] Phase 3: `hyperdht` — v6 simultaneous-open, relay/announce fields
- [ ] Phase 4: `hyperswarm` surface, docs, bootstrap AAAA

## Discussing

Feedback welcome — open an issue here, or join the thread on [hyperdht#1](https://github.com/holepunchto/hyperdht/issues/1). The open questions for maintainers are in [DESIGN.md §8](./DESIGN.md#8-open-questions-for-maintainers).

## License

[Apache-2.0](./LICENSE), matching the Holepunch ecosystem.
