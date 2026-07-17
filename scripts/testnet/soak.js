#!/usr/bin/env node
'use strict'

// Local soak harness for the IPv6 dht-rpc work (PLAN.md Phase 4b).
// Spins a mixed-family population on loopback, drives continuous pings +
// findNode queries between random pairs (respecting family reachability),
// logs per-node stats to ./soak-out/<name>.jsonl via stats-logger.js, then
// prints a summary table and gates on v6 pairing response rates.
//
// Population (defaults): 1 dual bootstrap + 2 dual + 2 v6-only + 2 v4-only
// over 127.0.0.1 / ::1.
//
// Env knobs:
//   DURATION        soak time in seconds (default 120)
//   NUM_DUAL        extra dual-stack nodes (default 2)
//   NUM_V6ONLY      v6-only nodes (default 2)
//   NUM_V4ONLY      v4-only nodes (default 2)
//   PING_INTERVAL   traffic tick in ms (default 150)
//   PINGS_PER_TICK  pings fired per tick (default 4)
//   FINDNODE_EVERY  run a findNode query every N ticks (default 10)
//   STATS_INTERVAL  stats-logger interval in seconds (default 10)
//   OUT_DIR         output dir (default ./soak-out relative to cwd)
//
// Exit code: 0 when every v6 pairing (ordered pair of v6-capable nodes)
// reached a ping response rate >= 90%, 1 otherwise (or on any unhandled
// rejection / setup failure).

const fs = require('fs')
const path = require('path')
const DHT = require('../../upstream/dht-rpc')
const StatsLogger = require('./stats-logger.js')

const DURATION_S = envNum('DURATION', 120)
const NUM_DUAL = envNum('NUM_DUAL', 2)
const NUM_V6ONLY = envNum('NUM_V6ONLY', 2)
const NUM_V4ONLY = envNum('NUM_V4ONLY', 2)
const PING_INTERVAL_MS = envNum('PING_INTERVAL', 150)
const PINGS_PER_TICK = envNum('PINGS_PER_TICK', 4)
const FINDNODE_EVERY = envNum('FINDNODE_EVERY', 10)
const STATS_INTERVAL_S = envNum('STATS_INTERVAL', 10)
const OUT_DIR = path.resolve(process.cwd(), process.env.OUT_DIR || 'soak-out')

const MIN_V6_RESPONSE_RATE = 0.9
const SETUP_TIMEOUT_MS = 60_000
const DRAIN_TIMEOUT_MS = 5_000

let unhandledRejections = 0
process.on('unhandledRejection', (err) => {
  unhandledRejections++
  log('UNHANDLED REJECTION:', err && (err.stack || err.message || err))
})

function envNum (key, dflt) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`)
  return n
}

function log (...parts) {
  process.stdout.write(parts.join(' ') + '\n')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout (promise, ms, what) {
  let timer = null
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function median (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---- population -----------------------------------------------------------

function makeMetrics () {
  return { sent: 0, ok: 0, rtts: [] }
}

function wrap (name, kind, dht) {
  return {
    name,
    kind, // 'dual' | 'v6' | 'v4'
    dht,
    findNodes: 0,
    metrics: { 4: makeMetrics(), 6: makeMetrics() }
  }
}

function hasV4 (node) {
  return node.kind !== 'v6'
}

// v6 capability can disappear at runtime if the dual node demoted (v6 bind
// failure), so check the live instance instead of just the kind.
function v6Instance (node) {
  if (node.kind === 'v6') return node.dht
  if (node.kind === 'v4') return null
  // dual: the v6 stack lives on the internal child DHT. dht.ping()/findNode()
  // are not family-routed, so v6-initiated traffic must use the child
  // directly (same internal handle index.js uses for host6/table6/address6).
  return node.dht._dht6
}

function sourceFor (node, family) {
  return family === 6 ? v6Instance(node) : (hasV4(node) ? node.dht : null)
}

function targetPort (node, family) {
  const address = family === 6 ? node.dht.address6() : node.dht.address()
  return address ? address.port : null
}

async function createPopulation () {
  const nodes = []

  const boot = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '::1',
    bootstrap: []
  })
  nodes.push(wrap('boot-dual', 'dual', boot))
  await withTimeout(boot.fullyBootstrapped(), SETUP_TIMEOUT_MS, 'bootstrap node startup')

  const bootstrap = [
    '127.0.0.1:' + boot.address().port,
    '[::1]:' + boot.address6().port
  ]

  const pending = []
  const spawn = (name, kind, opts) => {
    const dht = new DHT({ ephemeral: false, firewalled: false, bootstrap, ...opts })
    nodes.push(wrap(name, kind, dht))
    pending.push(dht.fullyBootstrapped())
  }

  for (let i = 1; i <= NUM_DUAL; i++) {
    spawn(`dual-${i}`, 'dual', { families: ['ipv4', 'ipv6'], host: '127.0.0.1', host6: '::1' })
  }
  for (let i = 1; i <= NUM_V6ONLY; i++) {
    spawn(`v6only-${i}`, 'v6', { families: ['ipv6'], host6: '::1' })
  }
  for (let i = 1; i <= NUM_V4ONLY; i++) {
    spawn(`v4only-${i}`, 'v4', { families: ['ipv4'], host: '127.0.0.1' })
  }

  await withTimeout(Promise.all(pending), SETUP_TIMEOUT_MS, 'population bootstrap')
  return nodes
}

// ---- traffic --------------------------------------------------------------

function buildEdges (nodes) {
  const edges = []
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue
      if (hasV4(a) && hasV4(b)) edges.push({ a, b, family: 4 })
      if (v6Instance(a) !== null && v6Instance(b) !== null) edges.push({ a, b, family: 6 })
    }
  }
  // interleave so no single pairing waits a whole round-robin cycle
  for (let i = edges.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const tmp = edges[i]
    edges[i] = edges[j]
    edges[j] = tmp
  }
  return edges
}

class Traffic {
  constructor (nodes) {
    this.nodes = nodes
    this.edges = buildEdges(nodes)
    this.pairings = new Map() // "a->b@fam" -> { a, b, family, sent, ok }
    this.inflight = 0
    this.findNodeErrors = 0
    this._edgeIndex = 0
    this._tick = 0
    this._timer = null
  }

  start () {
    this._timer = setInterval(() => this._onTick(), PING_INTERVAL_MS)
  }

  stop () {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  async drain (timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (this.inflight > 0 && Date.now() < deadline) await sleep(100)
  }

  _onTick () {
    this._tick++
    for (let i = 0; i < PINGS_PER_TICK; i++) {
      const edge = this.edges[this._edgeIndex++ % this.edges.length]
      this._firePing(edge)
    }
    if (FINDNODE_EVERY > 0 && this._tick % FINDNODE_EVERY === 0) this._fireFindNode()
  }

  _pairing (edge) {
    const key = `${edge.a.name}->${edge.b.name}@v${edge.family}`
    let entry = this.pairings.get(key)
    if (entry === undefined) {
      entry = { a: edge.a.name, b: edge.b.name, family: edge.family, sent: 0, ok: 0 }
      this.pairings.set(key, entry)
    }
    return entry
  }

  _firePing ({ a, b, family }) {
    const source = sourceFor(a, family)
    if (source === null || source.destroyed) return
    const port = targetPort(b, family)
    if (port === null) return

    const host = family === 6 ? '::1' : '127.0.0.1'
    const metrics = a.metrics[family]
    const pairing = this._pairing({ a, b, family })

    metrics.sent++
    pairing.sent++
    this.inflight++

    source.ping({ host, port })
      .then((res) => {
        metrics.ok++
        pairing.ok++
        if (typeof res.rtt === 'number') metrics.rtts.push(res.rtt)
      })
      .catch(() => {}) // timeouts/destroy already show up in the counters
      .finally(() => { this.inflight-- })
  }

  _fireFindNode () {
    const a = this.nodes[(Math.random() * this.nodes.length) | 0]
    const families = []
    if (hasV4(a)) families.push(4)
    if (v6Instance(a) !== null) families.push(6)
    if (families.length === 0) return
    const family = families[(Math.random() * families.length) | 0]

    const source = sourceFor(a, family)
    if (source === null || source.destroyed) return
    const candidates = this.nodes.filter((b) => b !== a && sourceFor(b, family) !== null)
    if (candidates.length === 0) return
    const b = candidates[(Math.random() * candidates.length) | 0]
    const target = family === 6 ? b.dht.table6.id : b.dht.table.id
    if (!target) return

    a.findNodes++
    this.inflight++
    const run = async () => {
      // drain the full query - each visited node counts in dht.stats
      for await (const _ of source.findNode(target)) {} // eslint-disable-line no-unused-vars
    }
    run()
      .catch(() => { this.findNodeErrors++ })
      .finally(() => { this.inflight-- })
  }
}

// ---- summary --------------------------------------------------------------

function familyLabel (node) {
  if (node.kind === 'dual') return v6Instance(node) !== null ? '4+6' : '4 (demoted)'
  return node.kind === 'v6' ? '6' : '4'
}

function statsTimeoutRate (node) {
  const stats = node.dht.stats
  let responses = stats.requests.responses
  let timeouts = stats.requests.timeouts
  // requests6 aliases requests on a v6-only node - only add it for duals
  if (node.kind === 'dual' && stats.requests6 !== undefined) {
    responses += stats.requests6.responses
    timeouts += stats.requests6.timeouts
  }
  const settled = responses + timeouts
  return settled === 0 ? 0 : timeouts / settled
}

function formatPct (rate) {
  return (rate * 100).toFixed(1) + '%'
}

function formatRtt (value) {
  return value === null ? '-' : value.toFixed(1) + 'ms'
}

function printSummary (nodes, traffic) {
  const header = ['node', 'family', 'pings', 'ok', 'resp%', 'timeout%', 'rtt4-med', 'rtt6-med', 'findNode']
  const rows = [header]

  for (const node of nodes) {
    const m4 = node.metrics[4]
    const m6 = node.metrics[6]
    const sent = m4.sent + m6.sent
    const ok = m4.ok + m6.ok
    rows.push([
      node.name,
      familyLabel(node),
      String(sent),
      String(ok),
      sent === 0 ? '-' : formatPct(ok / sent),
      formatPct(statsTimeoutRate(node)),
      formatRtt(median(m4.rtts)),
      formatRtt(median(m6.rtts)),
      String(node.findNodes)
    ])
  }

  const widths = header.map((_, col) => Math.max(...rows.map((row) => row[col].length)))
  log('')
  log('=== soak summary ===')
  for (let i = 0; i < rows.length; i++) {
    log(rows[i].map((cell, col) => cell.padEnd(widths[col] + 2)).join('').trimEnd())
    if (i === 0) log(widths.map((w) => '-'.repeat(w + 2)).join('').trimEnd())
  }
}

function evaluateGate (traffic) {
  const failures = []
  let checked = 0
  for (const pairing of traffic.pairings.values()) {
    if (pairing.family !== 6 || pairing.sent === 0) continue
    checked++
    const rate = pairing.ok / pairing.sent
    if (rate < MIN_V6_RESPONSE_RATE) {
      failures.push(`${pairing.a} -> ${pairing.b} (v6): ${pairing.ok}/${pairing.sent} = ${formatPct(rate)}`)
    }
  }

  log('')
  log(`=== v6 pairing gate (>= ${formatPct(MIN_V6_RESPONSE_RATE)} response rate) ===`)
  log(`${checked} v6 pairings measured, ${failures.length} below threshold`)
  for (const failure of failures) log('  FAIL ' + failure)
  return failures.length === 0
}

// ---- main -----------------------------------------------------------------

async function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  log(`soak: 1 dual bootstrap + ${NUM_DUAL} dual + ${NUM_V6ONLY} v6-only + ${NUM_V4ONLY} v4-only, ` +
    `${DURATION_S}s, stats -> ${OUT_DIR}`)

  let nodes = []
  const loggers = []
  let ok = false

  try {
    nodes = await createPopulation()
    log(`population up: ${nodes.map((n) => n.name).join(', ')}`)

    for (const node of nodes) {
      const outFile = path.join(OUT_DIR, `${node.name}.jsonl`)
      fs.writeFileSync(outFile, '') // truncate previous run
      const logger = new StatsLogger(node.dht, {
        name: node.name,
        intervalMs: STATS_INTERVAL_S * 1000,
        out: outFile
      })
      logger.start()
      loggers.push(logger)
    }

    const traffic = new Traffic(nodes)
    log(`traffic: ${traffic.edges.length} directed edges, ${PINGS_PER_TICK} pings / ${PING_INTERVAL_MS}ms, ` +
      `findNode every ${FINDNODE_EVERY} ticks`)
    traffic.start()

    await sleep(DURATION_S * 1000)

    traffic.stop()
    await traffic.drain(DRAIN_TIMEOUT_MS)

    for (const logger of loggers) logger.stop() // final sample while nodes are alive

    printSummary(nodes, traffic)
    ok = evaluateGate(traffic)
    if (traffic.findNodeErrors > 0) log(`note: ${traffic.findNodeErrors} findNode queries errored`)
  } finally {
    for (const logger of loggers) logger.stop()
    await Promise.all(nodes.map((node) =>
      node.dht.destroy().catch((err) => log(`destroy ${node.name} failed:`, err && err.message))
    ))
  }

  if (unhandledRejections > 0) {
    log(`FAIL: ${unhandledRejections} unhandled rejection(s)`)
    ok = false
  }

  log('')
  log(ok ? 'SOAK PASS' : 'SOAK FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err && err.stack}\n`)
  process.exit(1)
})
