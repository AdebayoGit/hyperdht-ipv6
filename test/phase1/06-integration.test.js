// PHASE 1 CONTRACT — DESIGN.md §7 integration matrix over loopback (::1):
//   v4-only <-> v4-only unchanged            (passes today)
//   dual    <-> v6-only connects             (RED until Phase 1)
//   v6-only <-> v4-only fails cleanly        (RED until Phase 1)
// The family-race single-connection assertion is a Phase 2 (hyperdht) test.

const test = require('brittle')
const DHT = require('../../upstream/dht-rpc')
const { missing } = require('./helpers.js')

async function makeDualBootstrap (t) {
  const boot = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '::1'
  })
  await boot.fullyBootstrapped()
  t.teardown(() => boot.destroy())
  if (missing(t, boot.address6, 'dht.address6()')) return null
  return boot
}

test('baseline: v4-only <-> v4-only over the same code path stays green', async function (t) {
  const boot = new DHT({ ephemeral: false, firewalled: false, host: '127.0.0.1' })
  await boot.fullyBootstrapped()
  const node = new DHT({
    ephemeral: false,
    host: '127.0.0.1',
    bootstrap: ['localhost:' + boot.address().port]
  })
  await node.fullyBootstrapped()
  t.teardown(async () => {
    await node.destroy()
    await boot.destroy()
  })

  const res = await node.ping({ host: '127.0.0.1', port: boot.address().port })
  t.is(res.from.port, boot.address().port)
})

test('v6-only node joins via a dual-stack bootstrap and pings over v6', async function (t) {
  const boot = await makeDualBootstrap(t)
  if (!boot) return

  const node = new DHT({
    ephemeral: false,
    families: ['ipv6'],
    host6: '::1',
    bootstrap: ['[::1]:' + boot.address6().port]
  })
  await node.fullyBootstrapped()
  t.teardown(() => node.destroy())

  const res = await node.ping({ host: '::1', port: boot.address6().port })
  t.is(res.from.port, boot.address6().port)
  t.is(res.to.host, '::1', 'echoed to-address comes back as 18-byte v6')
})

test('dual-stack node learns its external v6 address from echoed to', async function (t) {
  const boot = await makeDualBootstrap(t)
  if (!boot) return

  const node = new DHT({
    ephemeral: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '::1',
    bootstrap: [
      'localhost:' + boot.address().port,
      '[::1]:' + boot.address6().port
    ]
  })
  await node.fullyBootstrapped()
  t.teardown(() => node.destroy())

  t.ok(node.host, 'v4 external host learned (nat-sampler, unchanged)')
  t.ok(node.host6, 'v6 external host learned from v6 echoed to')
})

test('two v6-only nodes find each other through the v6 table', async function (t) {
  const boot = await makeDualBootstrap(t)
  if (!boot) return
  const bootstrap = ['[::1]:' + boot.address6().port]

  const a = new DHT({ ephemeral: false, families: ['ipv6'], host6: '::1', bootstrap })
  const b = new DHT({ ephemeral: false, families: ['ipv6'], host6: '::1', bootstrap })
  await a.fullyBootstrapped()
  await b.fullyBootstrapped()
  t.teardown(async () => {
    await a.destroy()
    await b.destroy()
  })

  // findNode across the v6 table: b must be discoverable from a
  let found = false
  for await (const data of a.findNode(b.table6.id)) {
    for (const n of data.closerNodes || []) {
      if (n.port === b.address6().port) found = true
    }
  }
  t.ok(found, 'v6 closerNodes gossip returns the other v6 node')
})

test('v6-only <-> v4-only does not bridge and fails cleanly', async function (t) {
  const boot4 = new DHT({ ephemeral: false, firewalled: false, host: '127.0.0.1' })
  await boot4.fullyBootstrapped()
  t.teardown(() => boot4.destroy())

  const v6only = new DHT({
    ephemeral: false,
    families: ['ipv6'],
    host6: '::1',
    bootstrap: ['localhost:' + boot4.address().port] // v4-only bootstrap
  })
  t.teardown(() => v6only.destroy())

  // documented non-goal: families don't bridge. The node must surface
  // "no nodes" behavior, not crash or hang forever.
  await t.execution(v6only.fullyBootstrapped(), 'bootstrapping resolves (empty) rather than crashing')
  if (missing(t, v6only.table6, 'dht.table6')) return
  t.is(v6only.table6.toArray().length, 0, 'no v4 node ever enters the v6 table')
})
