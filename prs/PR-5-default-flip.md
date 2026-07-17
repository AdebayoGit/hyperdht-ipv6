# PR 5 (staged) — flip the default to dual-stack

**Do not open until the gate below is met.** The diff is one line in dht-rpc:

```diff
-function normalizeFamilies (families) {
-  ... default ['ipv4']
+  ... default ['ipv4', 'ipv6']
```

(v6 bind failure already demotes to v4-only with a warning, so the flip is
safe on v4-only hosts by construction — that was designed in from phase 1.)

## Gate (PLAN.md Phase 4d)

1. Public testnet (3 dual-stack nodes, `scripts/testnet/node.js`) running ≥ 7
   consecutive days.
2. Reachability probe (cron, `scripts/testnet/README.md` §gate): a v6-only
   client resolves AAAA, joins, and pings — **100% daily success for 7 days**,
   evidenced by the JSONL logs committed to the design repo.
3. No v4 regression reports on PRs 1–4 in that window.
4. Bootstrap AAAA records live (see docs/BOOTSTRAP-OPS.md).

Attach the JSONL summary + soak output to the PR body when opening.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
