# PR 2 — hyperdht: IPv6 address exchange + family-race connect

**Branch:** `AdebayoGit/hyperdht#ipv6-phase2` → `holepunchto/hyperdht#main`
**Depends on:** PR 1 (dht-rpc `families` support); the branch is tested
against it via a local link — the dependency bump lands when dht-rpc releases.
**Open with:** `cd upstream/hyperdht && gh pr create -R holepunchto/hyperdht --head AdebayoGit:ipv6-phase2 --title "IPv6 address exchange and family-race connect" --body-file ../../prs/PR-2-hyperdht.md`

---

Revives the scope of #101 on top of dht-rpc's family-isolated IPv6, with the
two pitfalls that stalled it fixed:

1. **Race, don't prefer.** #101 tried v6 sequentially, so a stale advertised
   v6 address became a hard failure. Here a direct v6 connect (single-shot
   pings, 150 ms head start) races the *unchanged* v4 holepunch flow;
   the first raw stream wins at the existing `onsocket` claim point, and a
   dead v6 path degrades to v4 (chaos-tested).
2. **Capability echo.** New payload fields (flag 128+) are only encoded for
   peers that advertised v6 themselves; `addresses6` (flag 4) has been
   allocated and decoded since #93. v4-era decoders never see an unknown
   byte; `noisePayload.version` stays 1. Byte-level golden pins in the design
   repo hold v4-era payload shapes constant.

Connection identity is untouched: dedup on `remotePublicKey` via the existing
pool — racing families creates duplicate *attempts*, never duplicate
*connections* (asserted in the contract suite).

All 91 existing tests pass unmodified. Contract: 19 tests
(`test/phase2/` in https://github.com/AdebayoGit/hyperdht-ipv6), covering
echo gating, the race matrix (dual↔v6-only, exactly-one-connection,
clean cross-family failure), and mid-race v6 loss.

Scope note: this PR makes v6-only *clients* work against dual-stack servers.
Firewalled v6 servers, v6 relay coordination, and dual-DHT announces are
PR 3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
