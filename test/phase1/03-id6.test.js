// PHASE 1 CONTRACT — DESIGN.md §5.3: v6 node IDs hash the masked /64
// prefix + port so a routed /64 grants no more grindable IDs than one
// v4 address (~2^16). RED until Phase 1 lands.
//
// This pins the SIMPLE derivation: id6 = blake2b(addr[0..8] ‖ port-LE).
// If maintainers pick the BEP 42-style hybrid (§5.3 preferred option),
// replace the "spec recompute" test with constrained-prefix-bits checks —
// the masking properties below hold for both.

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const peer = require('../../upstream/dht-rpc/lib/peer.js')
const { missing } = require('./helpers.js')

test('peer exports id6', function (t) {
  t.is(typeof peer.id6, 'function')
})

test('id6 is 32 bytes and deterministic', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  const a = peer.id6('2001:db8::1', 4660)
  const b = peer.id6('2001:db8::1', 4660)
  t.is(a.byteLength, 32)
  t.ok(b4a.equals(a, b))
})

test('id6 matches spec: blake2b over masked /64 prefix + LE port', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  // receiver-side validateId6 recomputes exactly this, so the derivation
  // is part of the wire contract
  const host = '2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff'
  const port = 4660

  const addr = b4a.alloc(18)
  c.ipv6Address.encode({ start: 0, end: 18, buffer: addr }, { host, port })
  const input = b4a.alloc(10)
  input.set(addr.subarray(0, 8), 0) // first 64 bits of the address
  input[8] = port & 0xff
  input[9] = (port >> 8) & 0xff
  const expected = b4a.alloc(32)
  sodium.crypto_generichash(expected, input)

  t.ok(b4a.equals(peer.id6(host, port), expected))
})

test('id6 masks the interface identifier: same /64 -> same id', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  const a = peer.id6('2001:db8:1:2::1', 1000)
  const b = peer.id6('2001:db8:1:2:ffff:ffff:ffff:ffff', 1000)
  t.ok(b4a.equals(a, b), 'lower 64 bits must not influence the id')
})

test('id6 varies with the /64 prefix', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  const a = peer.id6('2001:db8:1:2::1', 1000)
  const b = peer.id6('2001:db8:1:3::1', 1000)
  t.absent(b4a.equals(a, b))
})

test('id6 varies with the port', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  const a = peer.id6('2001:db8:1:2::1', 1000)
  const b = peer.id6('2001:db8:1:2::1', 1001)
  t.absent(b4a.equals(a, b))
})

test('id6 differs from a v4 id built from colliding bytes', function (t) {
  if (missing(t, peer.id6, 'peer.id6')) return
  // 10-byte input domain must not collide with the 6-byte v4 domain
  const v4 = peer.id('1.2.3.4', 4660)
  const v6 = peer.id6('102:304::', 4660) // first bytes 01 02 03 04
  t.absent(b4a.equals(v4, v6))
})
