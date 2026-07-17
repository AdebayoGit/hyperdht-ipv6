// PHASE 1 CONTRACT — DESIGN.md §5.2: v6 codecs in dht-rpc/lib/peer.js.
// RED until Phase 1 lands in upstream/dht-rpc.

const test = require('brittle')
const b4a = require('b4a')
const peer = require('../../upstream/dht-rpc/lib/peer.js')
const { missing } = require('./helpers.js')

test('peer exports an ipv6 codec and ipv6Array', function (t) {
  t.ok(peer.ipv6, 'peer.ipv6 codec exported')
  t.ok(peer.ipv6Array, 'peer.ipv6Array codec exported')
})

test('ipv6 codec is 18 bytes: 16-byte host + LE uint16 port', function (t) {
  if (missing(t, peer.ipv6, 'peer.ipv6')) return
  const state = { start: 0, end: 0, buffer: null }
  peer.ipv6.preencode(state, { host: '2001:db8::1', port: 4660 })
  t.is(state.end, 18)

  state.buffer = b4a.alloc(state.end)
  peer.ipv6.encode(state, { host: '2001:db8::1', port: 4660 })
  // matches compact-encoding's c.ipv6Address layout exactly
  t.is(state.buffer.toString('hex'), '20010db80000000000000000000000013412')
})

test('ipv6 codec round-trips and injects id: null like ipv4 does', function (t) {
  if (missing(t, peer.ipv6, 'peer.ipv6')) return
  const buf = b4a.alloc(18)
  peer.ipv6.encode({ start: 0, end: 18, buffer: buf }, { host: '2001:db8:85a3::8a2e:370:7334', port: 65535 })
  const decoded = peer.ipv6.decode({ start: 0, end: 18, buffer: buf })
  t.is(decoded.host, '2001:db8:85a3::8a2e:370:7334')
  t.is(decoded.port, 65535)
  t.is(decoded.id, null, 'id: null injected for the callee, mirroring ipv4')
})

test('ipv6Array round-trips a closerNodes-style list', function (t) {
  if (missing(t, peer.ipv6Array, 'peer.ipv6Array')) return
  const nodes = [
    { host: '2001:db8::1', port: 1 },
    { host: 'fe80::1', port: 65535 },
    { host: '::1', port: 30000 }
  ]
  const state = { start: 0, end: 0, buffer: null }
  peer.ipv6Array.preencode(state, nodes)
  state.buffer = b4a.alloc(state.end)
  peer.ipv6Array.encode(state, nodes)

  const decoded = peer.ipv6Array.decode({ start: 0, end: state.end, buffer: state.buffer })
  t.is(decoded.length, 3)
  for (let i = 0; i < 3; i++) {
    t.is(decoded[i].host, nodes[i].host)
    t.is(decoded[i].port, nodes[i].port)
  }
})

test('adding ipv6 leaves the ipv4 codec untouched', function (t) {
  // belt-and-braces alongside 01-v4-golden: same assertion, colocated with
  // the change most likely to break it
  const state = { start: 0, end: 6, buffer: b4a.alloc(6) }
  peer.ipv4.encode(state, { host: '1.2.3.4', port: 4660 })
  t.is(state.buffer.toString('hex'), '010203043412')
})
