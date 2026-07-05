# Design: IPv6 support for dht-rpc / HyperDHT

**Status:** Draft for discussion, intended for [holepunchto/hyperdht#1](https://github.com/holepunchto/hyperdht/issues/1)
**Scope:** `dht-rpc`, `hyperdht`, `hyperswarm` (surface only), bootstrap infrastructure
**Author:** Ekundayo (@AdebayoGit)
**Date:** July 2026

---

## 1. Summary

This proposal adds IPv6 to the Hyperswarm networking stack as a **parallel, family-isolated DHT**, the same architecture BitTorrent chose in [BEP 32](https://www.bittorrent.org/beps/bep_0032.html). IPv4 wire messages remain byte-for-byte unchanged, so there is zero compatibility risk to the existing network. Dual-stack nodes participate in both families; connection establishment races families and dedupes on the Noise public key, which is already the stack's connection identity.

The transport is already ready: `libudx`/`udx-native` support IPv6 sockets, and `hyperdht`'s handshake payload has had an `addresses6` field (flag `4` in `noisePayload`) reserved since the current wire version. It is simply hard-coded to `[]` in `lib/connect.js` today. What's missing is the DHT routing layer and the holepunch/relay paths.

## 2. Motivation

- **IPv6-only networks exist and are growing**: meshnets (Yggdrasil, cjdns bridges), mobile carriers without 464XLAT, v6-only VPSes. These peers currently cannot reach the DHT at all.
- **CGNAT relief**: where both peers have global v6 addresses, "holepunching" reduces to a stateless simultaneous open through host firewalls, no NAT rebinding heuristics, no `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` failures, fewer relay fallbacks. Direct-connection success rates should rise on exactly the networks where v4 punching is weakest.
- **The stack is closer than it looks**: udx speaks v6; `noisePayload` reserved `addresses6`; `IO` already uses `udx.watchNetworkInterfaces()`. The remaining work is concentrated and enumerable, and this document enumerates it.

## 3. Current state (evidence)

| Layer | File | State |
|---|---|---|
| Transport | `libudx` / `udx-native` | IPv6 capable today |
| DHT routing | `dht-rpc/lib/peer.js` | Nodes/peers encoded exclusively as `c.ipv4Address` (6 bytes). Node ID = `blake2b(ipv4 ‖ port)` over exactly 6 bytes. |
| DHT wire | `dht-rpc/lib/io.js` | Request/response headers hard-code a 6-byte `to` address (`1 + 1 + 6 + 2`). `closerNodes` uses `peer.ipv4Array`. `validateId()` recomputes `hash(ipv4:port)`. Sockets bind `0.0.0.0`. |
| Handshake | `hyperdht/lib/messages.js` | `noisePayload` **already carries `addresses6`** (flag `4`, `ipv6Array` codec). All other address fields (`handshake.peerAddress/relayAddress`, `relayInfo`, `holepunchPayload.addresses/remoteAddress`, `peer.relayAddresses`) are IPv4-only. |
| Connect path | `hyperdht/lib/connect.js` | `addresses6: []` hard-coded; holepunch, LAN shortcut, and relay logic operate on `addresses4` only. |
| Bootstrap | hyperdht defaults | v4 listeners / A records only. |

## 4. Design goals and non-goals

**Goals**

1. IPv4 network behavior and wire format are untouched. An un-upgraded node never sees a byte it doesn't already parse.
2. Dual-stack nodes reach v6-only peers and vice versa is *not* promised (families don't bridge); dual-stack ↔ anything works.
3. One connection per peer regardless of address family (dedup on Noise key).
4. Eclipse resistance on v6 is **no weaker than v4** despite cheap v6 address space.
5. Incremental, per-package PRs, each shippable behind an option flag.

**Non-goals**

- Cross-family packet relaying inside the DHT (a dual-stack relay peer via the existing `relayThrough` mechanism already covers this at the connection layer).
- NAT64/CLAT detection heuristics.
- Changing the Noise handshake, `secret-stream`, or udx framing: nothing above addressing changes.

## 5. Proposed design

### 5.1 Two logical DHTs, one node

Following BEP 32: the v6 DHT is a **separate routing table, separate node ID, separate sockets**, running the same protocol. Rationale:

- v4 messages stay identical → zero migration risk (the strongest argument; the v4 DHT is load-bearing for every Pear app in production).
- No mixed-family `closerNodes` parsing ambiguity, no "which family is this 6-vs-18-byte blob" flag soup inside hot paths.
- Each table's ID scheme stays self-certifying against the family it serves (§5.3).

A node is one of: `v4-only` (today's behavior, default), `v6-only`, or `dual-stack` (joins both). Config:

```js
new DHT({ families: ['ipv4', 'ipv6'] }) // default today: ['ipv4']
```

### 5.2 dht-rpc wire changes (v6 messages only)

The first header byte already carries a 2-bit version (`VERSION = 0b11`) and 4-bit type. **v6 messages reuse the identical format with two deltas**, distinguished not by sniffing but by the socket family they arrive on (a message on a v6 socket *is* a v6 message):

1. The echoed `to` address, how a node learns its own external address, becomes `c.ipv6Address` (18 bytes). Header size: `1 + 1 + 18 + 2`.
2. `closerNodes` uses an `ipv6Array` codec.

`peer.js` gains:

```js
const ipv6 = { ...c.ipv6Address, decode: /* as ipv4, with id: null */ }
exports.ipv6Array = c.array(ipv6)

function id6 (host, port, out) {
  // see §5.3: hashes the masked /64 prefix, not the full address
}
```

No flag bits are consumed; v4 encoders/decoders are not touched. The `token()` scheme (`hash(host-string, secret)`) is family-agnostic and needs no change.

### 5.3 Node IDs and eclipse resistance (the one hard problem)

Today: `id = blake2b(ipv4 ‖ port)`, validated by every receiver (`validateId` in `io.js`). An attacker with one IPv4 address can grind ~2¹⁶ IDs (ports). Naively porting this to v6 hands an attacker with a routed /64 up to 2⁶⁴·2¹⁶ candidate IDs, enough to eclipse any target region of the keyspace.

**Proposal:** derive the v6 node ID from the **masked /64 prefix** plus port:

```
id6 = blake2b(addr[0..8] ‖ port)     // first 64 bits only
```

- Restores parity with v4: one routed prefix ≈ one v4 address ≈ 2¹⁶ grindable IDs.
- Receivers can still validate: `validateId6(id, from)` masks `from.host` the same way.
- Additionally, cap routing-table entries per /64 (e.g. 1) and per /48 (e.g. 8): the standard libtorrent-style hardening, cheap to enforce at insert time.

Trade-off acknowledged: multiple honest nodes behind one /64 (a home LAN) collide on the ID-per-port space. That is exactly v4's NAT situation today, and the DHT already tolerates it.

RFC 4941 privacy addresses rotate; `IO` already watches interfaces (`udx.watchNetworkInterfaces()`), so on address change the v6 side re-derives its ID and rejoins, the same flow as today's v4 roaming/`resume()` path. Prefer stable (non-temporary) addresses when the interface exposes the distinction.

### 5.4 Sockets and binding

`IO._bindSockets()` gains a v6 pair (client + server, mirroring v4) bound to `::` when `families` includes `ipv6`, with the same port-range logic. Bind failure on v6 (no v6 connectivity) demotes the node to v4-only with a warning rather than throwing: dual-stack must be safe to enable by default eventually.

### 5.5 hyperdht changes

All wire slots needed are either reserved already or free:

| Message | Change | Bits |
|---|---|---|
| `noisePayload` | **Populate** existing `addresses6` (flag `4`, already allocated & decoded) | none new |
| `noisePayload` | `relayAddresses6` | flag `128` (free) |
| `handshake` | `peerAddress6` / `relayAddress6` variants | flags `4`, `8` (free) |
| `holepunchPayload` | `addresses6` | flag `64` (free) |
| `relayInfo` | v6 variant carried under a flagged encoding rev | versioned by `noisePayload.version` |

Old peers ignore unknown flag bits *only if they don't attempt to decode past them*, and since every one of these structs is length-delimited by its flags, **new flags are only sent to peers that advertised v6** in their own `noisePayload` (capability echo), keeping strict decoders safe. `noisePayload.version` stays at `1`.

Connect path (`connect.js`):

- Stop hard-coding `addresses6: []`; populate from the v6 socket's observed external address (learned via the echoed `to` on the v6 DHT) plus non-deprecated local v6 addresses (LAN shortcut works unchanged: `isBogon`/`isReserved` already handle v6 literals via the `bogon` package).
- **Family selection:** race direct v6 against the v4 holepunch flow, Happy-Eyeballs style, with a small head start (~150 ms) for v6 since `firewall === OPEN` is the common v6 case. First raw stream to connect wins; `onsocket` already claims `c.rawStream` exactly once and ignores later winners. The dedup point exists today and needs no new machinery.
- **v6 "holepunch"** is a degenerate, simpler case: both sides open sessions toward each other's global addresses simultaneously (stateless firewall traversal). No rebind analysis, no `FIREWALL.RANDOM` handling. Model it as a new puncher strategy that short-circuits `probeRound` when both sides advertised global v6.

Announce/lookup records: `hyperdht/lib/messages.js` `peer.relayAddresses` stays v4 (relays must be reachable by the v4 DHT that stores the record); records stored on the **v6 DHT** use `ipv6Array` symmetric encoding. Dual-stack servers announce on both DHTs: same signed announce, two transports.

### 5.6 Deduplication policy

Connection identity is `remotePublicKey`, already enforced by the connection pool (`pool.has(publicKey)`) and `_socketPool.routes` keyed by public key. Racing families creates at most transient duplicate *attempts*, never duplicate *connections*. Server side: `NoiseSecretStream` handshake dedup on the key applies regardless of which family delivered the stream. This answers the duplicate-address concern raised in issue #1 with mechanisms that are already in the codebase.

### 5.7 Bootstrap

- Add AAAA records + v6 listeners to the existing bootstrap hostnames (requires Holepunch ops; testnet uses our own nodes until then).
- `dht-rpc` bootstrap resolution: resolve A and AAAA, route each result to its family's table.
- Ship a public **v6 testnet** (3 dual-stack nodes) with the PR series so reviewers can verify without infra changes.

## 6. Rollout & compatibility

| Phase | Ships | Risk |
|---|---|---|
| 1 | `dht-rpc`: v6 codecs, `id6`, dual sockets, per-family tables, behind `families` option (default `['ipv4']`) | None to existing users: pure addition |
| 2 | `hyperdht`: populate `addresses6`, capability echo, v6 direct-connect race | Flags only sent to v6-advertising peers |
| 3 | `hyperdht`: v6 simultaneous-open strategy, relay/holepunch v6 fields, announce on both DHTs | Guarded by same capability echo |
| 4 | `hyperswarm`: expose `families`, docs; bootstrap AAAA flip; consider default `dual` | Flag-day-free; default flip is a one-line revert |

Each phase is an independent PR with tests; nothing depends on a network flag day.

## 7. Testing

- Unit: codec round-trips (v4 untouched, golden-byte fixtures), `id6` validation, per-prefix table caps.
- Integration: extend `hyperdht`'s testnet helper to spin mixed populations (v4-only / v6-only / dual) and assert: v4-only ↔ v4-only unchanged; dual ↔ v6-only connects; v6-only ↔ v4-only fails cleanly (documented); family race yields exactly one connection per key.
- CI: loopback v6 (`::1`) works on all GitHub runners; add a ULA-prefix job for multi-address cases.
- Chaos: kill the v6 path mid-race, assert v4 fallback completes.

## 8. Open questions for maintainers

1. Is family-isolated (BEP 32-style) acceptable, or is there appetite for a unified table with family-tagged entries? (This draft argues isolation is strictly lower risk.)
2. `id6` masking width: /64 as proposed, or /56 to further blunt prefix-rich attackers at the cost of home-LAN collisions?
3. Preference on capability echo vs. bumping `noisePayload.version` to 2 for the new fields?
4. Bootstrap ops: willingness to add AAAA + v6 listeners once phases 1 and 2 land?
5. Should `pear-runtime`/Pear platform expose family config, or inherit `dual` silently once stable?

## 9. Prior art

- BitTorrent [BEP 32](https://www.bittorrent.org/beps/bep_0032.html) (IPv6 extension for DHT, family isolation) and [BEP 42](https://www.bittorrent.org/beps/bep_0042.html) (DHT security via IP-derived IDs, /64 masking for v6).
- libjuice/ICE and RFC 8305 (Happy Eyeballs) for the family race.
- libtorrent routing-table per-prefix caps.
