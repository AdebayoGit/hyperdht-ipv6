// PHASE 3 CONTRACT — DESIGN.md §5.5 announce/lookup: "Dual-stack servers
// announce on both DHTs: same signed announce, two transports. Records
// stored on the v6 DHT use ipv6Array symmetric encoding."
//
// DRAFT API pinned here:
//   - server.relayAddresses6 — the v6 sibling of server.relayAddresses,
//     populated by the announcer's v6-DHT announce leg (proof the announce
//     actually ran against v6 nodes).
//   - Lookups return family-appropriate results: a v6-only client's lookup
//     on the v6 DHT finds the dual server; a v4-only client's lookup is
//     byte-for-byte today's behavior.
//
// The dual server here is EPHEMERAL (and firewalled), so it is only findable
// through the testnet storing nodes — a v6-only client cannot reach it at all
// unless the v6 announce leg stored a v6 record AND the v6 handshake relay
// (04) works. That is what makes this suite RED before Phase 3.

const test = require('brittle')
const b4a = require('b4a')
const DHT = require('../../upstream/hyperdht')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const { missing, opened, withTimeout, TIMEOUT } = require('./helpers.js')

const CONNECT_TIMEOUT = 20000
const LOOKUP_TIMEOUT = 15000

async function findPeerInLookup (client, target, publicKey) {
  const query = client.lookup(target)
  for await (const data of query) {
    for (const peer of data.peers) {
      if (b4a.equals(peer.publicKey, publicKey)) return peer
    }
  }
  return null
}

test('dual server announces on both DHTs: v6-only and v4-only clients both find and connect', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  // Ephemeral + firewalled: only reachable through the announced records on
  // the storing nodes, on either family.
  const s = testnet.createNode({
    ephemeral: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  const server = s.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  if (missing(t, server.relayAddresses6, 'server.relayAddresses6 (v6 announce leg)')) return

  t.ok(server.relayAddresses6.length > 0, 'the announcer committed to at least one v6 relay node')
  for (const addr of server.relayAddresses6) {
    t.ok(addr.host.indexOf(':') > -1, 'v6 relay address is an IPv6 literal: ' + addr.host)
  }
  t.ok(server.relayAddresses.length > 0, 'the v4 announce leg still ran exactly as today')
  for (const addr of server.relayAddresses) {
    t.ok(addr.host.indexOf(':') === -1, 'v4 relay address stays IPv4: ' + addr.host)
  }

  const target = DHT.hash(server.publicKey)

  // --- v6-only client: lookup on the v6 DHT returns the record ---
  const v6client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })
  if (missing(t, v6client.table6, 'dht.table6 on a v6-only testnet node')) return

  const peer6 = await withTimeout(findPeerInLookup(v6client, target, server.publicKey), LOOKUP_TIMEOUT)
  if (peer6 === TIMEOUT) {
    t.fail('v6-only lookup hung')
    return
  }
  t.ok(peer6, 'lookup on the v6 DHT returned the announced peer')
  t.ok(Array.isArray(peer6.relayAddresses), 'v6 record decodes with a relayAddresses array')

  const socket6 = v6client.connect(server.publicKey)
  socket6.on('error', noop)
  t.teardown(() => socket6.destroy())

  const failure6 = await withTimeout(opened(socket6), CONNECT_TIMEOUT)
  if (failure6 === TIMEOUT) {
    t.fail('v6-only client could not connect to the dual announced server')
    return
  }
  if (failure6) {
    t.fail('v6-only connect failed: ' + (failure6.code || failure6.message))
    return
  }
  t.is(socket6.rawStream.remoteFamily, 6, 'v6-only client connected over IPv6')
  socket6.end()

  // --- v4-only client: everything exactly as today ---
  const v4client = testnet.createNode({ ephemeral: true })

  const peer4 = await withTimeout(findPeerInLookup(v4client, target, server.publicKey), LOOKUP_TIMEOUT)
  if (peer4 === TIMEOUT) {
    t.fail('v4-only lookup hung')
    return
  }
  t.ok(peer4, 'lookup on the v4 DHT still returns the announced peer')
  t.alike(peer4.relayAddresses, [], 'v4 record shape is exactly today\'s (empty relayAddresses)')

  const socket4 = v4client.connect(server.publicKey)
  socket4.on('error', noop)
  t.teardown(() => socket4.destroy())

  const failure4 = await withTimeout(opened(socket4), CONNECT_TIMEOUT)
  if (failure4 === TIMEOUT) {
    t.fail('v4-only client could not connect (v4 regression)')
    return
  }
  if (failure4) {
    t.fail('v4-only connect failed: ' + (failure4.code || failure4.message))
    return
  }
  t.is(socket4.rawStream.remoteFamily, 4, 'v4-only client connected over IPv4, as today')
  socket4.end()
})

test('unannounce clears the record on both DHTs', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const s = testnet.createNode({
    ephemeral: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  const server = s.createServer(function (socket) {
    socket.on('error', noop)
    socket.end()
  })
  await server.listen()

  if (missing(t, server.relayAddresses6, 'server.relayAddresses6 (v6 announce leg)')) return

  const target = DHT.hash(server.publicKey)
  const publicKey = server.publicKey

  await server.close() // triggers announcer.stop() -> unannounce on both DHTs

  const v6client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })
  const found = await withTimeout(findPeerInLookup(v6client, target, publicKey), LOOKUP_TIMEOUT)
  if (found === TIMEOUT) {
    t.fail('v6 lookup after unannounce hung')
    return
  }
  t.is(found, null, 'v6 DHT record is gone after unannounce')
})

function noop () {}
