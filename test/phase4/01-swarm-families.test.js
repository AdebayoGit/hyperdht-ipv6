// PHASE 4 CONTRACT — DESIGN.md §6 phase 4 / PLAN.md 4a: the hyperswarm
// surface. Hyperswarm's constructor DHT option allow-list threads `families`
// and `host6` through to hyperdht, so a dual-stack swarm server and a
// v6-only swarm client can meet on a topic end-to-end.
//
// Runs against upstream/hyperswarm (branch ipv6-phase4), which links the
// phase-2/3 upstream/hyperdht and, through it, the phase-1 upstream/dht-rpc.
//
// Every network wait is race-bounded so the gate fails cleanly, never hangs.

const test = require('brittle')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const Hyperswarm = require('../../upstream/hyperswarm')

const CONNECT_TIMEOUT = 45000

test('swarm families passthrough: dual-stack server <-> v6-only client meet on a topic', { timeout: 120000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })

  const server = new Hyperswarm({
    bootstrap: testnet.bootstrap,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  const client = new Hyperswarm({
    bootstrap: testnet.bootstrap,
    families: ['ipv6'],
    host6: '::1'
  })

  t.teardown(async () => {
    await server.destroy()
    await client.destroy()
  })

  // Clean RED (instead of a bogus v4<->v4 connection) if the constructor
  // allow-list still drops the options.
  if (client.dht.families.indexOf('ipv6') === -1) {
    t.fail('hyperswarm drops the families/host6 options (Phase 4 contract)')
    return
  }

  t.alike(server.dht.families, ['ipv4', 'ipv6'], 'server swarm dht is dual-stack')
  t.alike(client.dht.families, ['ipv6'], 'client swarm dht is v6-only')

  const serverConnected = onceConnection(server)
  const clientConnected = onceConnection(client)

  const topic = Buffer.alloc(32).fill('phase4 swarm families')
  await server.join(topic, { server: true, client: false }).flushed()
  client.join(topic, { client: true, server: false })

  const connected = await Promise.race([
    Promise.all([serverConnected, clientConnected]),
    sleep(CONNECT_TIMEOUT)
  ])

  if (!connected) {
    t.fail('dual-stack swarm server and v6-only swarm client did not pair on the topic within ' + CONNECT_TIMEOUT + ' ms')
    return
  }

  const [, clientConn] = connected

  t.pass('server side got the topic connection')
  t.is(clientConn.rawStream.remoteFamily, 6, 'client side connection runs over IPv6')

  // Give any (wrongly) surviving duplicate attempt time to surface (§5.6)
  await sleep(750)

  t.is(server.connections.size, 1, 'exactly one connection on the server swarm')
  t.is(client.connections.size, 1, 'exactly one connection on the client swarm')
})

function onceConnection (swarm) {
  return new Promise((resolve) => {
    swarm.once('connection', (conn) => {
      conn.on('error', noop)
      resolve(conn)
    })
  })
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function noop () {}
