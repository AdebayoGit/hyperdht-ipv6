# Phase 4b testnet + metrics tooling

Operational tooling for the IPv6 Hyperswarm effort (PLAN.md Phase 4b,
VERIFICATION.md §4). Everything here reads the per-family counters that
Phase 1 added to `upstream/dht-rpc` (`dht.stats.requests` /
`dht.stats.requests6`, `commands` / `commands6`, `table` / `table6`,
`host` / `host6`) — no new telemetry protocol.

| File | Purpose |
|---|---|
| `node.js` | Long-running (dual-stack by default) dht-rpc node for a public VPS. Non-ephemeral, `firewalled: false`, graceful SIGINT/SIGTERM. |
| `stats-logger.js` | JSONL stats poller. Module (`new StatsLogger(dht, opts)`) or standalone process that hosts its own node from the same env as `node.js`. |
| `soak.js` | Local mixed-family soak harness over `127.0.0.1` / `::1` with a response-rate gate. |

npm scripts (run from the harness root):

```bash
npm run testnet:node    # node scripts/testnet/node.js
npm run testnet:stats   # node scripts/testnet/stats-logger.js
npm run soak            # node scripts/testnet/soak.js
```

## 1. Running the public 3-node testnet

Three v6-capable VPSes (DESIGN §5.7). Each gets DNS `A` + `AAAA` records
(e.g. `testnet-1.example.com` … `testnet-3.example.com`) and an open UDP
port (default `10001`) on **both** address families.

Configuration is env-driven (or `--flag` equivalents, see the header of
`node.js`):

```bash
# testnet-1: first node up, seeds its own external addresses (bootstrap mode)
NAME=testnet-1 FAMILIES=ipv4,ipv6 \
HOST=203.0.113.10 HOST6=2001:db8:10::1 PORT=10001 \
STATS_FILE=/var/lib/dht-testnet/stats.jsonl INTERVAL=60 \
node scripts/testnet/node.js

# testnet-2 / testnet-3: join the mesh via the others (both families listed
# so each family's stack picks up its own entries)
NAME=testnet-2 FAMILIES=ipv4,ipv6 \
HOST=203.0.113.20 HOST6=2001:db8:20::1 PORT=10001 \
BOOTSTRAP='203.0.113.10:10001,[2001:db8:10::1]:10001' \
STATS_FILE=/var/lib/dht-testnet/stats.jsonl \
node scripts/testnet/node.js
```

Notes:

- With an empty `BOOTSTRAP` the node runs in bootstrap mode and requires
  `HOST`/`HOST6` to be its **public** address literals (mirrors
  `DHT.bootstrapper()`, extended to the v6 stack).
- `PORT6` defaults to the same number as `PORT` — one firewall rule per
  family. `anyPort` is off: if the port is taken the process fails loudly.
- A v6 bind failure demotes the node to v4-only instead of crashing
  (dht-rpc `warning` event, logged to stdout).
- SIGINT/SIGTERM take a final stats sample and destroy the DHT cleanly.

### systemd unit

```ini
# /etc/systemd/system/dht-testnet.service
[Unit]
Description=dht-rpc IPv6 testnet node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dht
WorkingDirectory=/opt/hyperdht-ipv6
Environment=NAME=testnet-1
Environment=FAMILIES=ipv4,ipv6
Environment=HOST=203.0.113.10
Environment=HOST6=2001:db8:10::1
Environment=PORT=10001
Environment=INTERVAL=60
Environment=STATS_FILE=/var/lib/dht-testnet/stats.jsonl
ExecStart=/usr/bin/node scripts/testnet/node.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dht-testnet
journalctl -u dht-testnet -f
```

Phase 4 verification (VERIFICATION §3): once all three are up, confirm
that a v6-only VPS and a v4-only host both bootstrap from the **same**
hostnames (AAAA + A). The standalone stats-logger doubles as the joiner:

```bash
# on a v6-only machine
FAMILIES=ipv6 PORT=0 BOOTSTRAP=testnet-1.example.com:10001 INTERVAL=30 \
  node scripts/testnet/stats-logger.js       # records to stdout
# on a v4-only machine
FAMILIES=ipv4 PORT=0 BOOTSTRAP=testnet-1.example.com:10001 INTERVAL=30 \
  node scripts/testnet/stats-logger.js
```

(`PORT=0` = ephemeral bind for clients; watch `v6.table.nodes` /
`v4.table.nodes` grow past 0 and `external.host6` / `external.host` get
learned from echoed `to` addresses.)

## 2. Local soak

```bash
DURATION=120 node scripts/testnet/soak.js          # or: npm run soak
```

Spins 1 dual bootstrap + 2 dual + 2 v6-only + 2 v4-only nodes on
loopback, drives round-robin pings plus periodic `findNode` queries
between every family-reachable ordered pair (v4-only and v6-only nodes
never target each other — families do not bridge), and runs a
`StatsLogger` per node into `./soak-out/<name>.jsonl`.

Knobs (env): `DURATION` (s, default 120), `NUM_DUAL`, `NUM_V6ONLY`,
`NUM_V4ONLY`, `PING_INTERVAL` (ms, default 150), `PINGS_PER_TICK` (4),
`FINDNODE_EVERY` (ticks, 10), `STATS_INTERVAL` (s, 10), `OUT_DIR`.

Output: a per-node summary table (family, pings sent, response rate,
timeout rate from `dht.stats`, v4/v6 rtt medians from `res.rtt`,
findNode count) plus the gate verdict. **Exit code is non-zero if any
ordered v6 pairing between v6-capable (dual or v6-only) nodes had a ping
response rate under 90%**, or if any unhandled rejection occurred.

Implementation note: dual-stack traffic uses the internal v6 child DHT
(`dht._dht6`) to *initiate* v6 pings, because `dht.ping()` is not
family-routed — same handle `index.js` itself uses for
`host6`/`table6`/`address6()`. Its counters surface publicly as
`dht.stats.requests6`.

## 3. JSONL schema

One JSON object per line, one line per sample (stable field set; the
authoritative doc lives at the top of `stats-logger.js`):

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 sample time |
| `name` | node label (`NAME` env / soak node name) |
| `uptimeMs` | ms since the logger was created |
| `families` | active families, post-demotion (`["ipv4","ipv6"]`, …) |
| `online`, `degraded` | `lib/health.js` verdict |
| `external.host`, `external.port` | learned external v4 (nat-sampler), `null` until learned |
| `external.host6`, `external.port6` | learned external v6, `null` until learned |
| `bound.port`, `bound.port6` | locally bound socket ports (`null` if family off) |
| `queries` | `dht.stats.queries` (`active`, `total`) |
| `v4`, `v6` | per-family section, `null` when the family is off/demoted |
| `vN.requests` | `active`, `total`, `responses`, `timeouts`, `retries` |
| `vN.commands` | `ping`/`pingNat`/`findNode`/`downHint`, each `{tx, rx}` |
| `vN.table` | `nodes` (total routing-table entries), `rows` (rows holding at least one node) |
| `vN.timeoutRate` | cumulative `timeouts / (responses + timeouts)` |
| `vN.intervalTimeoutRate` | same rate over just the last interval |

A v6-only node reports `v4: null` and all of its traffic under `v6`
(on such a node dht-rpc's `stats.requests6` aliases `stats.requests`).

## 4. Measuring the Phase 4d 7-day reachability gate

The default-`families` flip (PLAN.md Phase 4d) requires **7 days of 100%
testnet bootstrap reachability** for a v6-only client resolving the
public hostnames. Measured with these tools:

1. The three `node.js` testnet nodes append their own health/counters to
   `STATS_FILE` every 60 s (server-side view: timeout rates, table sizes,
   learned addresses).
2. A cron probe on an independent v6-only machine joins via AAAA and
   pings, appending one JSONL verdict per run (client-side view):

```bash
#!/usr/bin/env bash
# /opt/dht-testnet/probe-v6.sh  — crontab: */10 * * * * /opt/dht-testnet/probe-v6.sh
cd /opt/hyperdht-ipv6 || exit 1
node - <<'EOF' >> /var/log/dht-testnet/reachability.jsonl
const DHT = require('./upstream/dht-rpc')
const TARGET = 'testnet-1.example.com'   // published A + AAAA
const PORT = 10001
const started = Date.now()

async function main () {
  const dht = new DHT({ families: ['ipv6'], bootstrap: [TARGET + ':' + PORT] })
  let ok = false; let rtt = null; let error = null; let joined = 0
  try {
    await dht.fullyBootstrapped()                       // resolves AAAA, joins v6 table
    joined = dht.table6 ? dht.table6.toArray().length : 0
    const { host } = await dht.udx.lookup(TARGET, { family: 6 })
    const res = await dht.ping({ host, port: PORT })    // v6-only: ping goes over v6
    rtt = res.rtt
    ok = joined > 0 && res.from.port === PORT
  } catch (err) {
    error = err.message
  }
  await dht.destroy()
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    probe: 'v6-bootstrap-reachability',
    target: TARGET + ':' + PORT,
    ok, rtt, joined, ms: Date.now() - started, error
  }))
  process.exit(ok ? 0 : 1)
}

main()
EOF
```

3. The gate itself is then a one-liner over the last 7 days of probe
   output — it must show `ok == total`:

```bash
# GNU date (Linux); on macOS use: date -u -v-7d +%Y-%m-%dT%H:%M:%SZ
jq -s --arg since "$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  '[.[] | select(.ts >= $since)] | {total: length, ok: map(select(.ok)) | length}' \
  /var/log/dht-testnet/reachability.jsonl
```

Attach `reachability.jsonl`, the three nodes' `stats.jsonl` files
(v6 `timeoutRate` within 10% of v4 per VERIFICATION §4), and a passing
`soak.js` run to the flip PR as the soak evidence.
