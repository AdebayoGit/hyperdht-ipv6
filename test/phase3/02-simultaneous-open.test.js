// PHASE 3 CONTRACT — DESIGN.md §5.5: v6 "holepunch" is a degenerate,
// simpler case: both sides open sessions toward each other's advertised v6
// addresses simultaneously (stateless firewall traversal). No rebind
// analysis, no FIREWALL.RANDOM. Phase 2 made OPEN v6 servers reachable via
// the client-side race; Phase 3 makes FIREWALLED v6 servers reachable.
//
// DRAFT API pinned here:
//   - dht.stats.punches.open6 — counts connections claimed via the direct /
//     simultaneous-open v6 path (parallel to punches.open). This is the
//     observable proof the v6 strategy — not the v4 puncher — won.
//
// Every test guards with missing() (RED-not-crash today) and wraps network
// waits in withTimeout.

const test = require('brittle')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const { missing, opened, withTimeout, TIMEOUT } = require('./helpers.js')

const CONNECT_TIMEOUT = 20000

test('firewalled dual server <-> dual client: v6 simultaneous open wins, no v4 punch rounds', { timeout: 60000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  // Both sides have v6; the SERVER is explicitly firewalled, so the v4 path
  // has to go through the full relay/holepunch dance while the v6 path can
  // simultaneous-open directly.
  const a = testnet.createNode({
    ephemeral: true,
    firewalled: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  const b = testnet.createNode({
    ephemeral: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  if (missing(t, b.stats.punches.open6, 'dht.stats.punches.open6 (v6 simultaneous-open counter)')) return

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  const failure = await withTimeout(opened(socket), CONNECT_TIMEOUT)
  if (failure === TIMEOUT) {
    t.fail('firewalled dual <-> dual connect did not open within ' + CONNECT_TIMEOUT + 'ms')
    return
  }
  if (failure) {
    t.fail('connect failed: ' + (failure.code || failure.message))
    return
  }

  t.is(socket.rawStream.remoteFamily, 6, 'winning raw stream is IPv6')
  // wire-decoded v6 hosts are UNCOMPRESSED (see the phase 2 golden pin) - the
  // dialed loopback may surface as either spelling, so compare canonically
  t.ok(isV6Loopback(socket.rawStream.remoteHost), 'remoteHost is the v6 loopback address')
  t.ok(b.stats.punches.open6 >= 1, 'connection was claimed by the v6 simultaneous-open path')
  t.is(b.stats.punches.consistent, 0, 'no v4 consistent punch was needed')
  t.is(b.stats.punches.random, 0, 'no v4 random punch was needed')
  socket.end()
})

test('v6 simultaneous open still applies when BOTH sides are firewalled', { timeout: 60000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const a = testnet.createNode({
    ephemeral: true,
    firewalled: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  const b = testnet.createNode({
    ephemeral: true,
    firewalled: true,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  if (missing(t, b.stats.punches.open6, 'dht.stats.punches.open6 (v6 simultaneous-open counter)')) return

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  const failure = await withTimeout(opened(socket), CONNECT_TIMEOUT)
  if (failure === TIMEOUT) {
    t.fail('firewalled <-> firewalled dual connect did not open within ' + CONNECT_TIMEOUT + 'ms')
    return
  }
  if (failure) {
    t.fail('connect failed: ' + (failure.code || failure.message))
    return
  }

  t.is(socket.rawStream.remoteFamily, 6, 'winning raw stream is IPv6')
  t.ok(b.stats.punches.open6 >= 1, 'v6 simultaneous open claimed the stream')
  socket.end()
})

function isV6Loopback (host) {
  return host === '::1' || host === '0:0:0:0:0:0:0:1'
}

function noop () {}
