// GOLDEN v4 REGRESSION PINS — DESIGN.md goal 1: "An un-upgraded node never
// sees a byte it doesn't already parse."
//
// These tests pass against UNMODIFIED dht-rpc and must keep passing,
// byte-for-byte, after every Phase 1 change. Any failure here means the
// v4 wire format regressed and the change must be rejected.

const test = require('brittle')
const b4a = require('b4a')
const UDX = require('udx-native')
const DHT = require('../../upstream/dht-rpc')
const peer = require('../../upstream/dht-rpc/lib/peer.js')

// Fixture values generated from dht-rpc@6.27.0 (commit at clone time),
// BEFORE any IPv6 work. Do not regenerate; that would defeat the pin.
const GOLDEN = {
  ipv4Bytes: '010203043412', // encode({host:'1.2.3.4', port:4660}) — 4B host + LE uint16 port
  id_1_2_3_4_4660: '72601ad49350d0bf1a6a9aeb7337501a1603c1d85ae947bdf102385b1974cbf2',
  id_203_0_113_7_65535: '9977a22c0686bcc1e9a995ea407167b6e5b03bcb6d2889b8038e5bc3aad59298'
}

const VERSION = 0b11
const REQUEST_ID = (0b0000 << 4) | VERSION // 0x03
const RESPONSE_ID = (0b0001 << 4) | VERSION // 0x13
const PING = 0

test('golden: peer.ipv4 codec bytes are unchanged', function (t) {
  const state = { start: 0, end: 6, buffer: b4a.alloc(6) }
  peer.ipv4.encode(state, { host: '1.2.3.4', port: 4660 })
  t.is(state.buffer.toString('hex'), GOLDEN.ipv4Bytes)

  const decoded = peer.ipv4.decode({ start: 0, end: 6, buffer: state.buffer })
  t.is(decoded.host, '1.2.3.4')
  t.is(decoded.port, 4660)
  t.is(decoded.id, null, 'decode injects id: null for the callee')
})

test('golden: v4 node id derivation is unchanged', function (t) {
  t.is(peer.id('1.2.3.4', 4660).toString('hex'), GOLDEN.id_1_2_3_4_4660)
  t.is(peer.id('203.0.113.7', 65535).toString('hex'), GOLDEN.id_203_0_113_7_65535)
  t.is(peer.id('1.2.3.4', 4660).byteLength, 32)
})

test('golden: hand-crafted v4 ping request gets a well-formed v4 response', async function (t) {
  // A byte-literal PING request built to the exact wire layout of the
  // current network. If Phase 1 changes how a v4 socket parses or answers
  // this, production nodes would break.
  const node = new DHT({ ephemeral: false, firewalled: false, host: '127.0.0.1' })
  await node.fullyBootstrapped()
  t.teardown(() => node.destroy())

  const udx = new UDX()
  const sock = udx.createSocket()
  sock.bind(0, '127.0.0.1')
  t.teardown(() => sock.close())

  const me = sock.address()
  const tid = 0x2b1a

  // (type|version) + flags(internal) + tid + to(ipv4) + command
  const req = b4a.alloc(1 + 1 + 2 + 6 + 1)
  const state = { start: 0, end: req.byteLength, buffer: req }
  req[state.start++] = REQUEST_ID
  req[state.start++] = 4 // internal flag only
  req[state.start++] = tid & 0xff
  req[state.start++] = (tid >> 8) & 0xff
  peer.ipv4.encode(state, { host: '127.0.0.1', port: node.address().port })
  req[state.start++] = PING

  const reply = new Promise((resolve) => sock.once('message', resolve))
  await sock.send(req, node.address().port, '127.0.0.1')
  const buf = await reply

  t.is(buf[0], RESPONSE_ID, 'response type/version byte unchanged')
  t.is(buf.readUInt16LE(2), tid, 'tid echoed')

  // the echoed `to` is how a node learns its external addr — must stay 6-byte v4
  const to = peer.ipv4.decode({ start: 4, end: 10, buffer: buf })
  t.is(to.host, '127.0.0.1')
  t.is(to.port, me.port, 'echoed to-address is our observed v4 addr:port')
})

test('golden: v4-only swarm bootstraps and pings exactly as today', async function (t) {
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
