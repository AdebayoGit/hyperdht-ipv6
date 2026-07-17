'use strict'

// Per-family JSONL stats logger for a dht-rpc DHT instance
// (PLAN.md Phase 4b, VERIFICATION.md §4). Polls the instance every
// intervalMs (default 60s) and appends exactly one JSON object per line.
// No new telemetry protocol - everything reads the existing counters
// (dht.stats.requests / requests6, commands / commands6, tables, nat hosts).
//
// JSONL record schema (stable; fields are always present):
// {
//   "ts": "2026-07-17T12:00:00.000Z",   ISO timestamp of the sample
//   "name": "testnet-1",                node label
//   "uptimeMs": 60012,                  ms since the logger was created
//   "families": ["ipv4","ipv6"],        active families (post-demotion)
//   "online": true, "degraded": false,  lib/health verdict
//   "external": {                       learned external addresses
//     "host": "203.0.113.7",            v4 (nat-sampler), null until learned
//     "port": 10001,                    v4 external port, 0/null if unknown
//     "host6": "2001:db8::7",           v6 (v6 nat-sampler), null until learned
//     "port6": 10001                    v6 external port, null if unknown
//   },
//   "bound": { "port": 10001, "port6": 10001 },  locally bound socket ports
//   "queries": { "active": 0, "total": 12 },     dht.stats.queries
//   "v4": {                             null when ipv4 is not enabled
//     "requests": { "active":0,"total":100,"responses":98,"timeouts":2,"retries":3 },
//     "commands": { "ping":{"tx":..,"rx":..}, "pingNat":{..}, "findNode":{..}, "downHint":{..} },
//     "table": { "nodes": 12, "rows": 3 },  routing-table size: total nodes,
//                                           and rows that hold at least one node
//     "timeoutRate": 0.02,              cumulative timeouts/(responses+timeouts)
//     "intervalTimeoutRate": 0.0        same rate over just the last interval
//   },
//   "v6": { ...same shape as v4... }    null when ipv6 is not enabled/demoted;
//                                       for a v6-only node "v4" is null and all
//                                       traffic appears under "v6"
// }
//
// Usage as a module:
//   const StatsLogger = require('./stats-logger.js')
//   const logger = new StatsLogger(dht, { name, intervalMs, out })
//   logger.start()  // samples immediately, then every intervalMs
//   logger.stop()   // takes one final sample, stops the timer
// `out` is a file path (appended, JSONL) or a writable stream (stdout default).
//
// Standalone (hosts its own child node built from the same env as node.js):
//   FAMILIES=ipv4,ipv6 BOOTSTRAP=host:port INTERVAL=60 STATS_FILE=out.jsonl \
//     node scripts/testnet/stats-logger.js

const fs = require('fs')

const COMMAND_NAMES = ['ping', 'pingNat', 'findNode', 'downHint']

class StatsLogger {
  constructor (dht, { name = 'dht', intervalMs = 60_000, out = process.stdout } = {}) {
    this.dht = dht
    this.name = name
    this.intervalMs = intervalMs
    this._outPath = typeof out === 'string' ? out : null
    this._stream = typeof out === 'string' ? null : out
    this._timer = null
    this._started = Date.now()
    this._prev = null
    this._stopped = false
  }

  start () {
    if (this._timer !== null) return
    this.sample() // baseline sample at t0
    this._timer = setInterval(() => {
      try {
        this.sample()
      } catch (err) {
        process.stderr.write(`stats-logger sample failed: ${err && err.message}\n`)
      }
    }, this.intervalMs)
  }

  stop () {
    if (this._stopped) return
    this._stopped = true
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (!this.dht.destroyed) {
      try { this.sample() } catch {} // final sample
    }
  }

  sample () {
    const record = this.record()
    this._write(JSON.stringify(record) + '\n')
    return record
  }

  record () {
    const dht = this.dht
    const families = dht.families
    const hasV4 = families.includes('ipv4')
    const hasV6 = dht.stats.requests6 !== undefined && dht.table6 !== null

    // For a v6-only node stats.requests/commands ARE the v6 counters
    // (requests6 aliases them), so the v4 section must stay null there.
    const v4 = hasV4
      ? familySection(dht.stats.requests, dht.stats.commands, dht.table, this._prev && this._prev.v4)
      : null
    const v6 = hasV6
      ? familySection(dht.stats.requests6, dht.stats.commands6, dht.table6, this._prev && this._prev.v6)
      : null

    // external v6 port: public getters only expose host6. For a v6-only node
    // dht.port is the v6 external port; for a dual node read the internal v6
    // child (ops tooling - mirrors what index.js does for host6/table6).
    let port6 = null
    if (hasV6) port6 = hasV4 ? (dht._dht6 !== null ? dht._dht6.port : null) : dht.port

    const record = {
      ts: new Date().toISOString(),
      name: this.name,
      uptimeMs: Date.now() - this._started,
      families,
      online: dht.online,
      degraded: dht.degraded,
      external: {
        host: hasV4 ? dht.host : null,
        port: hasV4 ? dht.port : null,
        host6: dht.host6,
        port6
      },
      bound: {
        port: hasV4 ? addressPort(dht.address()) : null,
        port6: addressPort(dht.address6())
      },
      queries: {
        active: dht.stats.queries.active,
        total: dht.stats.queries.total
      },
      v4,
      v6
    }

    this._prev = record
    return record
  }

  _write (line) {
    if (this._outPath !== null) fs.appendFileSync(this._outPath, line)
    else this._stream.write(line)
  }
}

function familySection (requests, commands, table, prev) {
  const req = {
    active: requests.active,
    total: requests.total,
    responses: requests.responses,
    timeouts: requests.timeouts,
    retries: requests.retries
  }

  const cmds = {}
  for (const name of COMMAND_NAMES) {
    const counter = commands && commands[name]
    cmds[name] = counter ? { tx: counter.tx, rx: counter.rx } : { tx: 0, rx: 0 }
  }

  const nodes = table ? table.toArray().length : 0
  const rows = table ? table.rows.filter((row) => row && row.nodes.length > 0).length : 0

  const settled = req.responses + req.timeouts
  const timeoutRate = settled === 0 ? 0 : req.timeouts / settled

  let intervalTimeoutRate = 0
  if (prev && prev.requests) {
    const dResponses = req.responses - prev.requests.responses
    const dTimeouts = req.timeouts - prev.requests.timeouts
    const dSettled = dResponses + dTimeouts
    intervalTimeoutRate = dSettled <= 0 ? 0 : dTimeouts / dSettled
  }

  return {
    requests: req,
    commands: cmds,
    table: { nodes, rows },
    timeoutRate: round(timeoutRate),
    intervalTimeoutRate: round(intervalTimeoutRate)
  }
}

function addressPort (address) {
  return address ? address.port : null
}

function round (n) {
  return Math.round(n * 10000) / 10000
}

module.exports = StatsLogger

if (require.main === module) {
  const { parseConfig, createNode } = require('./node.js')

  const main = async () => {
    const config = parseConfig()
    const dht = createNode(config)
    // standalone default: stdout (pipe/redirect it), STATS_FILE to append to a file
    const out = process.env.STATS_FILE ? process.env.STATS_FILE : process.stdout
    const logger = new StatsLogger(dht, {
      name: config.name,
      intervalMs: config.intervalMs,
      out
    })

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      logger.stop()
      try { await dht.destroy() } catch {}
      process.exit(0)
    }
    process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)) })
    process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)) })

    await dht.fullyBootstrapped()
    logger.start()
    process.stderr.write(`stats-logger sampling '${config.name}' every ${config.intervalMs / 1000}s\n`)
  }

  main().catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack}\n`)
    process.exit(1)
  })
}
