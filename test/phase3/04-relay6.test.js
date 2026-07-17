// PHASE 3 CONTRACT — DESIGN.md §5.5: handshake peerAddress6 / relayAddress6
// (flags 4/8). Phase 2 shipped a clean refusal in lib/router.js: a
// v6-arriving PEER_HANDSHAKE was answered with closerNodes because the
// v4-era handshake message could not carry a v6 peerAddress. Phase 3 relays
// it, keeping the whole relay chain inside the v6 family (a relay can only
// answer on the socket the request arrived on).
//
// Codec contract (ties to the 01-wire-golden pins):
//   - flags 4/8 carry ipv6-coded peerAddress6/relayAddress6
//   - decoders only ATTACH the fields when their flag is present, so a
//     v4-era-shaped message decodes to exactly the v4-era object shape
//   - v4 and v6 fields can coexist (a dual relay may know both)

const test = require('brittle')
const b4a = require('b4a')
const m = require('../../upstream/hyperdht/lib/messages.js')
const createTestnet = require('../../upstream/hyperdht/testnet.js')
const { missing, opened, withTimeout, TIMEOUT } = require('./helpers.js')

const CONNECT_TIMEOUT = 20000

function enc (codec, value) {
  const state = { start: 0, end: 0, buffer: null }
  codec.preencode(state, value)
  state.buffer = b4a.alloc(state.end)
  codec.encode(state, value)
  return state.buffer
}

function dec (codec, buffer) {
  const state = { start: 0, end: buffer.byteLength, buffer }
  const value = codec.decode(state)
  return { value, state }
}

test('handshake peerAddress6/relayAddress6 round-trip (flags 4/8)', function (t) {
  const buffer = enc(m.handshake, {
    mode: 2,
    noise: b4a.from('deadbeef', 'hex'),
    peerAddress: null,
    relayAddress: null,
    peerAddress6: { host: '2001:db8::1', port: 4660 },
    relayAddress6: { host: '2001:db8::2', port: 30000 }
  })

  t.not(buffer[0] & 4, 0, 'flag 4 set for peerAddress6')
  t.not(buffer[0] & 8, 0, 'flag 8 set for relayAddress6')

  const { value, state } = dec(m.handshake, buffer)
  t.is(state.start, state.end, 'decoder consumes the message exactly')
  t.is(value.peerAddress, null, 'v4 peerAddress stays null')
  t.is(value.relayAddress, null, 'v4 relayAddress stays null')
  if (!value.peerAddress6 || !value.relayAddress6) {
    t.fail('peerAddress6/relayAddress6 did not round-trip (Phase 3 contract)')
    return
  }
  t.is(value.peerAddress6.host, '2001:db8:0:0:0:0:0:1', 'peerAddress6 host round-trips')
  t.is(value.peerAddress6.port, 4660)
  t.is(value.relayAddress6.host, '2001:db8:0:0:0:0:0:2', 'relayAddress6 host round-trips')
  t.is(value.relayAddress6.port, 30000)
})

test('handshake mixed families: v4 peerAddress + v6 relayAddress6 coexist', function (t) {
  const buffer = enc(m.handshake, {
    mode: 3,
    noise: b4a.from('cafe', 'hex'),
    peerAddress: { host: '1.2.3.4', port: 4660 },
    relayAddress: null,
    relayAddress6: { host: '2001:db8::2', port: 30000 }
  })

  t.not(buffer[0] & 1, 0, 'flag 1 set for the v4 peerAddress')
  t.is(buffer[0] & 2, 0, 'flag 2 absent (no v4 relayAddress)')
  t.is(buffer[0] & 4, 0, 'flag 4 absent (no peerAddress6)')
  t.not(buffer[0] & 8, 0, 'flag 8 set for relayAddress6')

  const { value, state } = dec(m.handshake, buffer)
  t.is(state.start, state.end, 'decoder consumes the message exactly')
  t.is(value.peerAddress.host, '1.2.3.4')
  t.is(value.relayAddress, null)
  t.is('peerAddress6' in value, false, 'absent flag 4 attaches no peerAddress6 key')
  if (!value.relayAddress6) {
    t.fail('relayAddress6 did not round-trip (Phase 3 contract)')
    return
  }
  t.is(value.relayAddress6.port, 30000)
})

test('v4-era decoders never see the new flags (golden-pin tie-in)', function (t) {
  // Exactly the 01-wire-golden handshake pin: a v4-shaped message must stay
  // byte-identical, meaning flags 4/8 never leak into v4-era traffic.
  const buffer = enc(m.handshake, {
    mode: 2,
    noise: b4a.from('deadbeef', 'hex'),
    peerAddress: { host: '1.2.3.4', port: 4660 },
    relayAddress: { host: '5.6.7.8', port: 30000 }
  })
  t.is(buffer.toString('hex'), '030204deadbeef010203043412050607083075', 'byte-identical to the golden pin')
  t.is(buffer[0] & 12, 0, 'flags 4/8 absent from a v4-era shape')

  const { value } = dec(m.handshake, buffer)
  t.is('peerAddress6' in value, false, 'v4-era decode has no peerAddress6 key')
  t.is('relayAddress6' in value, false, 'v4-era decode has no relayAddress6 key')
})

test('a v6-arriving handshake is relayed (phase 2 refused it): v6-only client reaches a firewalled dual server through a relay', { timeout: 90000 }, async function (t) {
  const testnet = await createTestnet(3, {
    teardown: t.teardown,
    families: ['ipv4', 'ipv6'],
    host6: '::1'
  })
  if (missing(t, testnet.nodes[0].address6, 'dht.address6() (createTestnet families support)')) return

  // The server is ephemeral + firewalled: a v6-only client can only reach it
  // if the storing node RELAYS the v6-arriving PEER_HANDSHAKE to the server
  // over v6, carrying the client as peerAddress6. Phase 2 replied with
  // closerNodes here, so this connect failed.
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

  const client = testnet.createNode({ ephemeral: true, families: ['ipv6'], host6: '::1' })
  if (missing(t, client.table6, 'dht.table6 on a v6-only testnet node')) return

  const socket = client.connect(server.publicKey)
  socket.on('error', noop)
  t.teardown(() => socket.destroy())

  const failure = await withTimeout(opened(socket), CONNECT_TIMEOUT)
  if (failure === TIMEOUT) {
    t.fail('v6-only -> firewalled dual server connect did not open (v6 handshake was not relayed)')
    return
  }
  if (failure) {
    t.fail('connect failed instead of relaying the v6 handshake: ' + (failure.code || failure.message))
    return
  }

  t.is(socket.rawStream.remoteFamily, 6, 'relayed handshake produced an IPv6 stream')
  // wire-decoded v6 hosts are UNCOMPRESSED (see the phase 2 golden pin)
  t.ok(isV6Loopback(socket.rawStream.remoteHost), 'remoteHost is the v6 loopback address')
  socket.end()
})

function isV6Loopback (host) {
  return host === '::1' || host === '0:0:0:0:0:0:0:1'
}

function noop () {}
