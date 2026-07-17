// PHASE 1 CONTRACT — DESIGN.md §5.3: "cap routing-table entries per /64
// (e.g. 1) and per /48 (e.g. 8) ... the caps, not the hash, carry most of
// the security weight." RED until Phase 1 lands.
//
// Proposed API (pinned here, adjust with maintainer feedback):
//   new DHT({ families: ['ipv6'], host6: '::1' })
//   dht.table6  — kademlia routing table for the v6 family
//   dht.addNode({ host, port }) auto-routes by address family

const test = require('brittle')
const DHT = require('../../upstream/dht-rpc')
const { missing } = require('./helpers.js')

function createV6 (opts = {}) {
  return new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv6'],
    host6: '::1',
    ...opts
  })
}

function tableSize (table) {
  let n = 0
  for (const row of table.rows) n += row.nodes.length
  return n
}

test('v6 node exposes a v6 routing table', async function (t) {
  const dht = createV6()
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())
  t.ok(dht.table6, 'dht.table6 exists')
})

test('per-/64 cap: many ports from one /64 occupy at most 1 slot', async function (t) {
  const dht = createV6()
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())
  if (missing(t, dht.table6, 'dht.table6')) return

  for (let port = 40000; port < 40064; port++) {
    dht.addNode({ host: '2001:db8:dead:beef::1', port })
  }
  t.ok(tableSize(dht.table6) <= 1, `one /64 holds <= 1 entry (got ${tableSize(dht.table6)})`)
})

test('per-/48 cap: many /64s inside one /48 occupy at most 8 slots', async function (t) {
  const dht = createV6()
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())
  if (missing(t, dht.table6, 'dht.table6')) return

  // 64 distinct /64s, all inside 2001:db8:1::/48
  for (let i = 0; i < 64; i++) {
    dht.addNode({ host: `2001:db8:1:${i.toString(16)}::1`, port: 40001 })
  }
  t.ok(tableSize(dht.table6) <= 8, `one /48 holds <= 8 entries (got ${tableSize(dht.table6)})`)
})

test('distinct /48s are not throttled by the caps', async function (t) {
  const dht = createV6()
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())
  if (missing(t, dht.table6, 'dht.table6')) return

  for (let i = 1; i <= 16; i++) {
    dht.addNode({ host: `2001:db8:${i.toString(16)}00::1`, port: 40001 })
  }
  t.ok(tableSize(dht.table6) >= 12, `unrelated prefixes fill the table (got ${tableSize(dht.table6)})`)
})

test('v4 table never receives v6 nodes and vice versa (family isolation)', async function (t) {
  const dht = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '::1'
  })
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())
  if (missing(t, dht.table6, 'dht.table6')) return

  dht.addNode({ host: '2001:db8::7', port: 40001 })
  dht.addNode({ host: '192.0.2.7', port: 40001 })

  t.is(tableSize(dht.table), 1, 'v4 table has exactly the v4 node')
  t.is(tableSize(dht.table6), 1, 'v6 table has exactly the v6 node')
})
