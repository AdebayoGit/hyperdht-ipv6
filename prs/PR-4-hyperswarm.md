# PR 4 — hyperswarm: expose `families` (IPv6 opt-in surface)

**Branch:** `AdebayoGit/hyperswarm#ipv6-phase4` → `holepunchto/hyperswarm#main`
**Depends on:** PR 2/3 (hyperdht IPv6); trivial once those land.
**Open with:** `cd upstream/hyperswarm && gh pr create -R holepunchto/hyperswarm --head AdebayoGit:ipv6-phase4 --title "Expose families option (IPv6 opt-in)" --body-file ../../prs/PR-4-hyperswarm.md`

---

Hyperswarm's DHT construction passes a fixed allow-list of options; `families`
is currently dropped silently. This threads it (plus `host6`) through:

```js
new Hyperswarm({ families: ['ipv4', 'ipv6'] }) // default stays ['ipv4']
```

No behavior change unless opted in; a swarm-level mixed-family join test
(dual-stack ↔ v6-only over a dual testnet) rides along, registered in
`test/all.js` for both runtimes.

Rollout per the design (https://github.com/AdebayoGit/hyperdht-ipv6):
bootstrap AAAA records + v6 listeners are an ops task tracked separately;
flipping the default to dual-stack is a one-line follow-up gated on 7 days
of testnet reachability data.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
