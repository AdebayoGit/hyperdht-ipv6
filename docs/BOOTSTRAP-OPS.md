# Bootstrap ops request (Holepunch infrastructure)

External dependency for Phase 4 — requires Holepunch ops access; everything
below is ready to hand over.

## Ask

1. **AAAA records** on the existing bootstrap hostnames (e.g.
   `node1.bootstrap.hyperdht.org` …), pointing at v6 listeners on the same
   hosts. No new hostnames: dht-rpc (phase 1) resolves A + AAAA per entry and
   routes each result to its family's table, so old clients see no change
   (they only consume A records).
2. **v6 listeners** on the bootstrap nodes: run the phase-1 dht-rpc with
   `families: ['ipv4','ipv6']`. The v4 socket/port/behavior is untouched;
   the v6 side binds `::` with `ipv6Only` (never intercepts v4 traffic).
   Rollback = restart with the old config (family demotion also makes a
   half-applied rollout harmless).

## Interim (no ops dependency)

Reviewers can verify against a self-hosted testnet today:

```bash
# on each of 3 dual-stack VPSes (see scripts/testnet/README.md for systemd)
FAMILIES=ipv4,ipv6 PORT=49737 node scripts/testnet/node.js
```

and point clients at it via `bootstrap: ['host:49737', '[v6addr]:49737']`.

## Verification after the flip

`scripts/testnet/README.md` §gate: the v6-only cron probe against the
official hostnames, 7 days at 100%, then PR-5 opens.
