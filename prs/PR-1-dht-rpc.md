# PR 1 — dht-rpc: IPv6 support (family-isolated parallel DHT)

**Branch:** `AdebayoGit/dht-rpc#ipv6-phase1` → `holepunchto/dht-rpc#main`
**Open with:** `cd upstream/dht-rpc && gh pr create -R holepunchto/dht-rpc --head AdebayoGit:ipv6-phase1 --title "IPv6 support: family-isolated parallel DHT (opt-in)" --body-file ../../prs/PR-1-dht-rpc.md`

---

Adds opt-in IPv6 per the design in https://github.com/AdebayoGit/hyperdht-ipv6
(discussion: holepunchto/hyperdht#1). BEP 32 architecture: the v6 DHT is a
separate routing table, separate node ID, separate `ipv6Only` sockets running
the same protocol. **The IPv4 wire format is byte-for-byte unchanged** and the
default (`families: ['ipv4']`) binds nothing new — all 52 existing tests pass
unmodified, plus byte-level golden pins in the design repo prove the v4 bytes.

## API

```js
const dht = new DHT({ families: ['ipv4', 'ipv6'], host6: undefined, port6: 0 })
dht.families    // active families; v6 bind failure demotes to ['ipv4'] + 'warning'
dht.address6()  // v6 socket address or null
dht.host6       // external v6 host learned from the echoed `to`
dht.table6      // v6 routing table
dht.stats.requests6, dht.stats.commands6
```

## Wire (v6 sockets only)

Same message format; the echoed `to` is 18 bytes (`c.ipv6Address`) and
`closerNodes` uses an ipv6 array codec. Which parser applies is decided by the
socket family, never by sniffing. v4 encoders/decoders untouched.

## Node IDs / eclipse resistance

`id6 = blake2b(masked /64 prefix ‖ port)` — one routed /64 yields the same
~2^16 grindable IDs as one v4 address (BEP 42's approach). Receivers validate
by recomputing. Additionally the v6 table caps entries per /64 (1) and per
/48 (8) at insert time; loopback/link-local/ULA are exempt so LAN/test
topologies work. Known corner (documented in the design, §5.3): two hosts in
one /64 pinning the same explicit port collide; the BEP 42-style hybrid
derivation is a contained follow-up if preferred — see design §8 Q2.

## Notes for review

- Dual-stack composition: the instance runs the v4 stack; an internal child
  DHT runs the isolated v6 stack (lifecycle wired into destroy/suspend/resume).
- v6 sockets bind with `ipv6Only` so v4-mapped traffic can never reach the
  v6 parser.
- Security review notes and the full test contract (31 tests incl. ::1
  integration matrix) live in the design repo (`test/phase1/`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
