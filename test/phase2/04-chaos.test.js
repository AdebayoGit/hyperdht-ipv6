// PHASE 2 CONTRACT — DESIGN.md §7 chaos: "kill the v6 path mid-race, assert
// v4 fallback completes." RED until Phase 2 lands in upstream/hyperdht.
//
// DRAFT API pinned here: `dht.socket6` — the v6 client socket handle,
// parallel to the existing `dht.socket` getter (dht-rpc: io.clientSocket ->
// io6.clientSocket). Closing it is the chaos hook; a Happy-Eyeballs race that
// loses its v6 leg must still converge on v4 with no duplicate connections
// and no hang.
//
// Every test guards with missing() (RED-not-crash today) and wraps network
// waits in withTimeout.

const test = require('brittle')
const { once } = require('events')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const { missing, withTimeout, TIMEOUT } = require('./helpers.js')

const CONNECT_TIMEOUT = 20000

async function dualPair (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return null

  const a = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })
  const b = testnet.createNode({ ephemeral: true, families: ['ipv4', 'ipv6'], host6: '::1' })

  if (missing(t, b.socket6, 'dht.socket6 (v6 client socket handle, chaos hook)')) return null
  return { testnet, a, b }
}

test('initiator loses its v6 socket mid-race: connection still completes over v4', { timeout: 60000 }, async function (t) {
  const pair = await dualPair(t)
  if (!pair) return
  const { a, b } = pair

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  // Chaos: the moment the race is in flight, the initiator's v6 leg dies —
  // e.g. the interface dropped its global address (RFC 4941 rotation, wifi
  // handoff). The v6 head start (~150ms, DESIGN §5.5) must not strand the
  // connect: the v4 holepunch flow keeps running and wins.
  setImmediate(() => {
    try {
      b.socket6.close()
    } catch {
      // already closed/never bound — the race must tolerate both
    }
  })

  const opened = await withTimeout(once(socket, 'open'), CONNECT_TIMEOUT)
  if (opened === TIMEOUT) {
    t.fail('connect hung after losing the v6 socket mid-race (no v4 fallback)')
    return
  }

  t.is(socket.rawStream.remoteFamily, 4, 'fallback connection completed over v4')
  t.ok(socket.rawStream.remoteHost, 'raw stream has a remote host')
  socket.end()
})

test('responder v6 goes dark mid-race: advertised addresses6 stop answering, v4 completes', { timeout: 60000 }, async function (t) {
  const pair = await dualPair(t)
  if (!pair) return
  const { a, b } = pair

  if (missing(t, a.socket6, 'dht.socket6 on the responder')) return

  const server = a.createServer(function (socket) {
    socket.on('error', noop)
    socket.on('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  // Chaos: the responder advertised v6 addresses in its noisePayload, but by
  // the time the initiator dials them the responder's v6 sockets are gone.
  // The initiator's v6 attempt gets no answer — stale addresses6 must degrade
  // to the v4 path, never to a hang or a hard failure.
  setImmediate(() => {
    try {
      a.socket6.close()
    } catch {
      // already closed/never bound — the race must tolerate both
    }
  })

  const opened = await withTimeout(once(socket, 'open'), CONNECT_TIMEOUT)
  if (opened === TIMEOUT) {
    t.fail('connect hung on stale addresses6 (no v4 fallback)')
    return
  }

  t.is(socket.rawStream.remoteFamily, 4, 'connection converged on v4 after v6 went dark')
  socket.end()
})

function noop () {}
