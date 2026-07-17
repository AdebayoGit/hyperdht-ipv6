// PHASE 1 CONTRACT — DESIGN.md §5.1, §5.4: families option, dual socket
// pairs, safe demotion when v6 bind fails. RED until Phase 1 lands.

const test = require('brittle')
const DHT = require('../../upstream/dht-rpc')
const { missing } = require('./helpers.js')

test('default family set is ipv4-only (today\'s behavior)', async function (t) {
  const dht = new DHT({ ephemeral: false, firewalled: false, host: '127.0.0.1' })
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())

  t.alike(dht.families, ['ipv4'], 'families defaults to [ipv4]')
  t.is(dht.address6 ? dht.address6() : null, null, 'no v6 socket by default')
})

test('dual-stack node binds a v6 socket pair alongside v4', async function (t) {
  const dht = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '::1'
  })
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())

  if (missing(t, dht.address6, 'dht.address6()')) return
  const a4 = dht.address()
  const a6 = dht.address6()
  t.ok(a4.port > 0, 'v4 bound')
  t.ok(a6 && a6.port > 0, 'v6 bound')
  t.is(a6.family, 6)
  t.not(a4.port === 0, 'both socket pairs live simultaneously')
})

test('v6-only node binds no v4 DHT socket', async function (t) {
  const dht = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv6'],
    host6: '::1'
  })
  await dht.fullyBootstrapped()
  t.teardown(() => dht.destroy())

  if (missing(t, dht.address6, 'dht.address6()')) return
  const a6 = dht.address6()
  t.ok(a6 && a6.port > 0, 'v6 bound')
  t.is(a6.family, 6)
})

test('v6 bind failure demotes to v4-only instead of throwing', async function (t) {
  // 100::/64 is the discard prefix (RFC 6666) — never a local address,
  // so binding it must fail. DESIGN.md §5.4: demote with a warning,
  // do not throw; dual-stack must eventually be safe as a default.
  const dht = new DHT({
    ephemeral: false,
    firewalled: false,
    families: ['ipv4', 'ipv6'],
    host: '127.0.0.1',
    host6: '100::1'
  })

  await t.execution(dht.fullyBootstrapped(), 'node still comes up')
  t.teardown(() => dht.destroy())

  t.alike(dht.families, ['ipv4'], 'demoted to v4-only')
  t.ok(dht.address().port > 0, 'v4 path unaffected')
})
