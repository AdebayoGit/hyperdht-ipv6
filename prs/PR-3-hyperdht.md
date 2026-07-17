# PR 3 — hyperdht: v6 simultaneous-open, relayed v6 handshakes, dual-DHT announces

**Branch:** `AdebayoGit/hyperdht#ipv6-phase3` → stacked on `#ipv6-phase2` (PR 2)
**Open with:** `cd upstream/hyperdht && gh pr create -R holepunchto/hyperdht --head AdebayoGit:ipv6-phase3 --base main --title "IPv6: simultaneous-open, v6 handshake relay, dual-DHT announces" --body-file ../../prs/PR-3-hyperdht.md`

---

Completes the DHT layer of the IPv6 design
(https://github.com/AdebayoGit/hyperdht-ipv6, targets #1). With PR 2, v6-only
*clients* could connect; this makes **firewalled v6 servers reachable** and
**v6-only lookups return results**.

## Simultaneous open (the v6 "holepunch")

Applies when both sides advertised v6 in the noise handshake (capability
echo). Both sides burst 1-byte packets toward each other's advertised global
v6 addresses (0/250/1000 ms, stateless, no probe rounds, no rebind analysis,
no `FIREWALL.RANDOM`), opening their own firewall pinholes; the client claims
the first pong at the existing single-claim `onsocket` point. The v4
relay/holepunch flow runs underneath the whole time and wins whenever v6
loses — teardown errors are parked until the last v6 attempt fails, so a dead
v6 path degrades, never hangs. New counter: `stats.punches.open6`.

## Wire

- handshake: `peerAddress6`/`relayAddress6` (flags 4/8); `holepunchPayload.addresses6` (flag 64) — all encoded only for v6-advertising peers; byte-level golden pins hold v4-era shapes constant.
- **No `relayInfo6` / no version bump** (deviation from the design draft, for the better): v6 coordination rides inside the already-encrypted `holepunchPayload` over existing v4 relays, and pure-v6 connections use the relayed v6 handshake + simultaneous open instead of punch rounds. `noisePayload.version` stays 1.

## Relay & storage

v6-arriving `PEER_HANDSHAKE` relays over family-locked chains (a relay only
answers on the socket family a request arrived on — no cross-family hops).
Announces on the v6 DHT use symmetric v6 record encoding, verify against the
storing node's family id, and live in a separate `records6` cache; **v4
record bytes are byte-identical to today**. Dual-stack servers announce the
same signed record on both DHTs — both via the `server.listen()` announcer
and via the plain `announce()`/`lookup()`/`unannounce()` APIs, which fan out
through a merged dual-family query stream (`lib/dual-query.js`; one leg's
failure never suppresses the other family's results). The plain-API path is
what hyperswarm's topic discovery uses, and it's covered by its own contract
cases after slipping past the first cut of this phase.

## Verification

91/91 existing tests unmodified; 14-test phase 3 contract
(`test/phase3/` in the design repo): wire golden pins, firewalled v6↔v6
simultaneous open, dual announce found by both v4-only and v6-only clients,
v6 handshake relay round-trips. Phase 1/2 gates stay green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
