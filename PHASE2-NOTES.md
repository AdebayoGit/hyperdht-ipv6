# Phase 2 notes: archaeology of hyperdht#101 (and #93)

Sources: `gh pr view 101 -R holepunchto/hyperdht --comments`, `gh pr diff 101`,
`gh pr view 93`. Retrieved 2026-07-17.

- PR: [holepunchto/hyperdht#101](https://github.com/holepunchto/hyperdht/pull/101) — "Implement IPv6 support for peer connections", @kasperisager
- Opened 2022-08-15, closed unmerged 2025-03-14. 9 commits, 3 files: `lib/connect.js`, `lib/server.js`, `package.json`.
- Declared dependencies: [libudx#111](https://github.com/holepunchto/libudx/pull/111) and [libudx#120](https://github.com/holepunchto/libudx/pull/120) (dual-stack sockets; merged, ship in udx today).
- Prerequisite context: [#93](https://github.com/holepunchto/hyperdht/pull/93) "Lock down IP object shapes" (merged 2022-07-28) deliberately kept v4/v6 as separate fields so no `family` tag is needed on the wire — the `ipv6`/`ipv6Array` codecs and `addresses6` flag-4 slot in `lib/messages.js` are its residue.

## What #101 implemented, and how

Server side (`lib/server.js`):
- Replaced the single `addresses` list with `addresses4`/`addresses6`, split by `addr.family` from `dht.io.networkInterfaces`, filtered by `addr.internal || isBogon(addr.host)`, all sharing `this.dht.port`.
- Sent `addresses6` unconditionally in the noisePayload (no capability echo — safe only because flag 4 is already in every v1 decoder).
- Bumped `bogon` to ^1.1.0 for v6-aware bogon checks (already present in today's tree).

Client side (`lib/connect.js`):
- In `holepunch()`, for the `FIREWALL.OPEN` / relayed-but-not-holepunchable case: iterate `[...payload.addresses6, ...payload.addresses4]` (v6 preferred), skip `isPrivate`, take the FIRST hit and `c.onsocket(...)` — then `return`.
- LAN shortcut: same merged iteration for private addresses.
- Relied on libudx's dual-stack default bind (one socket serving both families) rather than per-family sockets — hence kasperisager's scope note: *"this PR now only deals with exchanging IPv6 addresses between peers"* (2022-11-07). No DHT routing, announce, relay, or holepunch-coordination changes.

## What reviewers said

- Only substantive review activity was kasperisager's own inline nudge to drop a host default in favor of the libudx default (2022-11-04).
- @mafintosh (2023-05-30): *"looks good! will do some practical testing of this tomorrow. Mind fixing the conflicts?"* — positive; no design objection was ever recorded.

## Why it stalled

Timeline tells the story: ready-for-review 2022-10-11 → maintainer response 2023-05-30 (~7 months). By then `main` had been heavily refactored (connect.js gained the LAN-vs-holepunch race, relaying, socket pool, semaphore-gated find). kasperisager the same day: *"`main` has changed significantly it seems, so this will need additional work"* — then silence until *"Closing for now"* (2025-03-14). It died of rebase debt and review latency, not rejection. mafintosh's promised "practical testing" results were never posted, so no hidden technical blocker is documented.

## Lessons Phase 2 must carry in

1. **Race, don't prefer.** #101's client took the first non-private address, v6 first, then `return` — a peer advertising an unreachable v6 address (v6-advertising server, v4-only client path, stale/filtered v6) turns into a hard connect failure with no v4 fallback. This is the strongest argument for DESIGN §5.5's Happy-Eyeballs race with the v4 flow kept running; our `03`/`04` suites pin exactly this.
2. **Address selection needs deprecated-address handling.** `internal || isBogon` was the only filter; RFC 4941 temporary/deprecated addresses would be advertised and then rotate away mid-connection. DESIGN §5.5 requires non-deprecated addresses; the `04` chaos suite pins survival when advertised v6 goes stale.
3. **No capability echo existed.** Only safe because #101 confined itself to flag 4. Anything beyond (relay fields, handshake variants, flags ≥ 128) needs the echo — pinned in `02`, with the strict v4-era decoder demonstrating why.
4. **Port assumption.** #101 reused `dht.port` for every interface address — wrong if v4/v6 sockets bind different ports. Phase 2 must take the port from the family's own socket (Phase 1 `address6()`).
5. **Single dual-stack socket vs per-family sockets.** #101 leaned on libudx's dual-stack bind. DESIGN §5.1/§5.4 uses family-isolated sockets (BEP 32); the v6 observed-external-address must come from the v6 DHT's echoed `to`, not from interface enumeration alone (which can't see NAT/firewall reality).
6. **v6 host strings are not canonical.** Current-truth pin in `01`: compact-encoding decodes `2001:db8::1` back as `2001:db8:0:0:0:0:0:1`. Any address comparison (dedup, `diffAddress`, cache keys) must canonicalize, or the same address will look different on the two sides of a round-trip.
7. **Process, not design, killed #101.** Keep Phase 2 small (it maps to #101's exact file surface plus the race), keep it conflict-free, attach the test suite, and don't let it sit — connect.js churns fast.

## Delta between #101 and this Phase 2

Same ground: populate `addresses6` server-side, consume it client-side, bogon-filter, LAN shortcut for both families. New here: capability echo (`02`), family race with dedup on `remotePublicKey` (`03`), chaos fallback (`04`), per-family sockets/ports via Phase 1 dht-rpc, and byte-golden pins (`01`) so the v4 wire provably never moves.
