// PHASE 2 CONTRACT — DESIGN.md §5.5/§5.6/§7 connect matrix over loopback.
// RED until Phase 2 lands in upstream/hyperdht (which itself needs Phase 1
// dht-rpc: families/host6/address6()/table6).
//
// DRAFT API pinned here (update-first if maintainer feedback differs):
//   - new HyperDHT({ families: ['ipv4','ipv6'], host6: '::1' }) threads the
//     Phase 1 dht-rpc option through unchanged: dht.table6, dht.address6(),
//     dht.host6 all surface on hyperdht instances.
//   - createTestnet(n, { families, host6, ... }) spins dual-stack testnet
//     nodes and includes a v6 entry in testnet.bootstrap so v6-only nodes
//     can join; testnet.createNode({ families, host6 }) mirrors it.
//   - The family race dedupes at the existing onsocket claim point: exactly
//     one 'connection' per remotePublicKey, ever (§5.6).
//
// Every test guards with missing() so it fails RED today instead of crashing,
// and every network wait is wrapped in withTimeout so nothing can hang.

const test = require('brittle')
const { once } = require('events')
const DHT = require('../../upstream/hyperdht')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const { missing, withTimeout, TIMEOUT } = require('./helpers.js')

const CONNECT_TIMEOUT = 20000

test('(d) families option threads through HyperDHT constructor to dht-rpc', { timeout: 60000 }, async function (t) {
  const node = new DHT({
    ephemeral: true,
    bootstrap: [],
    host: '127.0.0.1',
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  t.teardown(() => node.destroy())

  if (missing(t, node.table6, 'dht.table6 (families passthrough to dht-rpc)')) return
  if (missing(t, node.address6, 'dht.address6()')) return

  const booted = await withTimeout(node.fullyBootstrapped(), 10000)
  if (booted === TIMEOUT) {
    t.fail('fullyBootstrapped() hung for a dual-stack node with an empty bootstrap')
    return
  }

  const addr6 = node.address6()
  t.ok(addr6, 'v6 socket bound')
  t.is(addr6.host, '::1', 'bound to the requested host6')
  t.ok(addr6.port > 0, 'v6 port allocated')
  t.ok(node.address().port > 0, 'v4 side unchanged alongside')
  t.is(node.host6 !== undefined, true, 'dht.host6 getter exists')
})

test('(a) dual-stack server <-> v6-only client connects, raw stream is v6', { timeout: 60000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  const [, a] = testnet.nodes

  if (missing(t, a.address6, 'dht.address6() (createTestnet families support)')) return

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })
  if (missing(t, client.table6, 'dht.table6 on a v6-only testnet node')) return

  const socket = client.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  const opened = await withTimeout(once(socket, 'open'), CONNECT_TIMEOUT)
  if (opened === TIMEOUT) {
    t.fail('dual <-> v6-only connect did not open within ' + CONNECT_TIMEOUT + 'ms')
    return
  }

  t.is(socket.rawStream.remoteFamily, 6, 'winning raw stream is IPv6')
  t.is(socket.rawStream.remoteHost, '::1', 'remoteHost is the v6 loopback address')
  socket.end()
})

test('(b) dual <-> dual race yields exactly one connection per remotePublicKey', { timeout: 60000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  const a = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })
  const b = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })

  const serverPool = a.pool()
  const clientPool = b.pool()
  let serverConns = 0
  let clientConns = 0
  serverPool.on('connection', () => serverConns++)
  clientPool.on('connection', () => clientConns++)

  const server = a.createServer({ pool: serverPool }, function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey, { pool: clientPool })
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  const opened = await withTimeout(once(socket, 'open'), CONNECT_TIMEOUT)
  if (opened === TIMEOUT) {
    t.fail('dual <-> dual connect did not open within ' + CONNECT_TIMEOUT + 'ms')
    return
  }

  // Both families were viable; give the losing attempt time to (wrongly)
  // surface a duplicate before asserting.
  await new Promise((resolve) => setTimeout(resolve, 750))

  t.is(clientConns, 1, "exactly one 'connection' on the client pool")
  t.is(serverConns, 1, "exactly one 'connection' on the server pool")
  t.is([...clientPool.connections].length, 1, 'client pool holds one stream for the key')
  t.is([...serverPool.connections].length, 1, 'server pool holds one stream for the key')
  t.is(b.connect(server.publicKey, { pool: clientPool }), socket, 'reconnect dedupes on remotePublicKey')
  socket.end()
})

test('(c) v6-only <-> v4-only fails with a clean error, no hang', { timeout: 60000 }, async function (t) {
  // Documented non-goal (DESIGN §4): families do not bridge. The failure must
  // be a surfaced Error, not a crash and not an eternal pending connect.
  const testnet = await createTestnet(3, { teardown: t.teardown }) // plain v4-only testnet
  const [, a] = testnet.nodes

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.end()
  })
  await server.listen()

  const v6only = new DHT({
    ephemeral: true,
    families: ['ipv6'],
    host6: '::1',
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => v6only.destroy())

  if (missing(t, v6only.table6, 'dht.table6 (v6-only mode)')) return

  const socket = v6only.connect(server.publicKey)
  t.teardown(() => socket.destroy())
  socket.on('open', () => t.fail('families must not bridge: v6-only reached a v4-only server'))

  const errored = await withTimeout(once(socket, 'error'), CONNECT_TIMEOUT)
  if (errored === TIMEOUT) {
    t.fail('v6-only -> v4-only connect hung instead of failing cleanly')
    return
  }

  const [err] = errored
  t.ok(err instanceof Error, 'failure surfaces as an Error on the socket')
  t.ok(
    /PEER_NOT_FOUND|PEER_CONNECTION_FAILED/.test(err.code || err.message),
    'error is the existing clean not-found/failed class, got: ' + (err.code || err.message)
  )
  t.ok(socket.destroyed || socket.destroying, 'socket torn down after the clean failure')
})

function noop () {}
