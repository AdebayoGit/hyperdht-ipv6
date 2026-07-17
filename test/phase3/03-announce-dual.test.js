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

// --- PHASE 3 GAP (plain APIs) ---------------------------------------------
// server.listen()'s Announcer fans out to both DHTs, but the plain
// dht.announce()/lookup()/unannounce() APIs — the exact ones hyperswarm's
// PeerDiscovery consumes — only ran on the node's own (v4) stack. On a dual
// node they must be family-complete: announce() stores on both DHTs,
// lookup() surfaces both families' records, unannounce() clears both.

async function collectLookup (client, target) {
  const seen = new Map()
  const query = client.lookup(target)
  for await (const data of query) {
    for (const peer of data.peers) {
      seen.set(b4a.toString(peer.publicKey, 'hex'), peer)
    }
  }
  return seen
}

test('plain announce on a dual node is found by v4-only and v6-only lookups', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const dual = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })
  const keyPair = DHT.keyPair()
  const target = DHT.hash(keyPair.publicKey)

  // mixed-family relay addresses: each stored record must only carry its own
  // family (a v6-only client cannot use a v4 relay address and vice versa)
  const relayAddresses = [
    { host: '127.0.0.1', port: 12345 },
    { host: '::1', port: 12346 }
  ]

  await dual.announce(target, keyPair, relayAddresses).finished()

  const v4client = testnet.createNode({ ephemeral: true })
  const found4 = await withTimeout(findPeerInLookup(v4client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  if (found4 === TIMEOUT) {
    t.fail('v4-only lookup hung')
    return
  }
  t.ok(found4, 'v4-only lookup finds the plain-announced record')
  if (found4) {
    t.ok(found4.relayAddresses.length > 0, 'v4 record kept the v4 relay address')
    for (const addr of found4.relayAddresses) {
      t.ok(addr.host.indexOf(':') === -1, 'v4 record only carries v4 relay addresses: ' + addr.host)
    }
  }

  const v6client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })
  const found6 = await withTimeout(findPeerInLookup(v6client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  if (found6 === TIMEOUT) {
    t.fail('v6-only lookup hung')
    return
  }
  t.ok(found6, 'v6-only lookup finds the plain-announced record (v6 DHT leg ran)')
  if (found6) {
    t.ok(found6.relayAddresses.length > 0, 'v6 record kept the v6 relay address')
    for (const addr of found6.relayAddresses) {
      t.ok(addr.host.indexOf(':') > -1, 'v6 record only carries v6 relay addresses: ' + addr.host)
    }
  }
})

test('plain lookup on a dual node surfaces v4-only and v6-only announcers', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const v4announcer = testnet.createNode({ ephemeral: true })
  const v6announcer = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })

  const kp4 = DHT.keyPair()
  const kp6 = DHT.keyPair()
  const target = DHT.hash(kp4.publicKey)

  await v4announcer.announce(target, kp4, []).finished()
  await v6announcer.announce(target, kp6, []).finished()

  const dual = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })

  const seen = await withTimeout(collectLookup(dual, target), LOOKUP_TIMEOUT)
  if (seen === TIMEOUT) {
    t.fail('dual lookup hung')
    return
  }

  t.ok(seen.has(b4a.toString(kp4.publicKey, 'hex')), 'dual lookup sees the record announced on the v4 DHT')
  t.ok(seen.has(b4a.toString(kp6.publicKey, 'hex')), 'dual lookup sees the record announced on the v6 DHT')
})

test('plain unannounce on a dual node clears the record on both DHTs', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const dual = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })
  const keyPair = DHT.keyPair()
  const target = DHT.hash(keyPair.publicKey)

  await dual.announce(target, keyPair, []).finished()

  const v4client = testnet.createNode({ ephemeral: true })
  const v6client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })

  const found4 = await withTimeout(findPeerInLookup(v4client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  const found6 = await withTimeout(findPeerInLookup(v6client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  if (found4 === TIMEOUT || found6 === TIMEOUT) {
    t.fail('pre-unannounce lookup hung')
    return
  }
  t.ok(found4, 'record stored on the v4 DHT before unannounce')
  t.ok(found6, 'record stored on the v6 DHT before unannounce')

  await dual.unannounce(target, keyPair)

  const gone4 = await withTimeout(findPeerInLookup(v4client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  if (gone4 === TIMEOUT) {
    t.fail('v4 lookup after unannounce hung')
    return
  }
  t.is(gone4, null, 'v4 DHT record is gone after plain unannounce')

  const gone6 = await withTimeout(findPeerInLookup(v6client, target, keyPair.publicKey), LOOKUP_TIMEOUT)
  if (gone6 === TIMEOUT) {
    t.fail('v6 lookup after unannounce hung')
    return
  }
  t.is(gone6, null, 'v6 DHT record is gone after plain unannounce')
})

function noop () {}
