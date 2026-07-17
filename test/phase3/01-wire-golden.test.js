// GOLDEN hyperdht WIRE PINS for Phase 3 — DESIGN.md §5.5 wire-slot table:
//
//   handshake        peerAddress6 (flag 4) / relayAddress6 (flag 8)
//   holepunchPayload addresses6   (flag 64), gated on the Phase 2 capability
//                                 echo (m.peerHasV6)
//   relayInfo        stays v4; versioned by noisePayload.version which STAYS 1
//
// The pins below were generated from the PHASE 2 lib/messages.js (commit
// 1529b1b), BEFORE any Phase 3 change. Do not regenerate; that would defeat
// the pin. Contract: every v4-era-shaped payload stays byte-identical, and
// the new flag bits only ever appear for peers that advertised v6 themselves.

const test = require('brittle')
const b4a = require('b4a')
const m = require('../../upstream/hyperdht/lib/messages.js')

const GOLDEN = {
  // flags 3 (peerAddress|relayAddress), mode 2, 4B noise, two 6-byte v4
  // addresses. Identical to the phase 2 pin — flags 4/8 now belong to the
  // v6 variants and MUST stay absent from this shape.
  handshake: '030204deadbeef010203043412050607083075',

  // flags 0x3e = punching|addresses|remoteAddress|token|remoteToken.
  // Flag 64 now belongs to addresses6 and MUST stay absent from this shape.
  holepunchPayload:
    '3e00020301cb0071073412c6336402224e' + '01'.repeat(32) + '02'.repeat(32),

  // Server-shaped noisePayload with holepunch relayInfo + relayAddresses.
  // relayInfo keeps its fixed 12-byte v4 layout and the version byte stays 1:
  // there is no relayInfo6 — v6 holepunch coordination rides in the encrypted
  // holepunchPayload.addresses6 instead (see 04-relay6 + report).
  serverShaped:
    '015b00020701cb0071011127c6336402224e01c6336402224e010001000101cb0071011127'
}

function enc (codec, value) {
  const state = { start: 0, end: 0, buffer: null }
  codec.preencode(state, value)
  state.buffer = b4a.alloc(state.end)
  codec.encode(state, value)
  return state
}

function dec (codec, hex) {
  const buffer = b4a.from(hex, 'hex')
  const state = { start: 0, end: buffer.byteLength, buffer }
  const value = codec.decode(state)
  return { value, state }
}

function v4HolepunchPayload () {
  return {
    error: 0,
    firewall: 2,
    round: 3,
    connected: false,
    punching: true,
    addresses: [{ host: '203.0.113.7', port: 4660 }],
    remoteAddress: { host: '198.51.100.2', port: 20002 },
    token: b4a.alloc(32, 1),
    remoteToken: b4a.alloc(32, 2)
  }
}

test('golden: v4-era handshake stays byte-identical (flags 4/8 free for v6)', function (t) {
  const state = enc(m.handshake, {
    mode: 2,
    noise: b4a.from('deadbeef', 'hex'),
    peerAddress: { host: '1.2.3.4', port: 4660 },
    relayAddress: { host: '5.6.7.8', port: 30000 }
  })
  t.is(state.buffer.toString('hex'), GOLDEN.handshake)
  t.is(state.buffer[0] & ~3, 0, 'no flag bits beyond 1|2 for a v4-era shape')

  const { value, state: ds } = dec(m.handshake, GOLDEN.handshake)
  t.is(ds.start, ds.end, 'decoder consumes the message exactly')
  t.is(value.peerAddress.host, '1.2.3.4')
  t.is(value.relayAddress.port, 30000)
  t.is('peerAddress6' in value, false, 'v4-era decode never grows a peerAddress6 key')
  t.is('relayAddress6' in value, false, 'v4-era decode never grows a relayAddress6 key')
})

test('golden: v4-era holepunchPayload stays byte-identical (flag 64 free for v6)', function (t) {
  const state = enc(m.holepunchPayload, v4HolepunchPayload())
  t.is(state.buffer.toString('hex'), GOLDEN.holepunchPayload)
  t.is(state.buffer[0] & 64, 0, 'flag 64 absent from a v4-era shape')

  const { value, state: ds } = dec(m.holepunchPayload, GOLDEN.holepunchPayload)
  t.is(ds.start, ds.end, 'decoder consumes the payload exactly')
  t.is(value.round, 3)
  t.is(value.addresses[0].host, '203.0.113.7')
  t.is('addresses6' in value, false, 'v4-era decode never grows an addresses6 key')
})

test('golden: holepunchPayload addresses6 is withheld without the capability echo', function (t) {
  // The peer did NOT advertise v6 (peerHasV6 false) — the encoding must be
  // byte-identical to a payload with no addresses6 at all, exactly like the
  // Phase 2 gate on noisePayload flag bits >= 128.
  const gated = enc(m.holepunchPayload, {
    ...v4HolepunchPayload(),
    addresses6: [{ host: '2001:db8::1', port: 4660 }],
    peerHasV6: false
  })
  t.is(gated.buffer.toString('hex'), GOLDEN.holepunchPayload)
  t.is(gated.buffer[0] & 64, 0, 'flag 64 withheld from a non-v6 peer')
})

test('golden: holepunchPayload addresses6 round-trips for a v6-advertising peer', function (t) {
  const state = enc(m.holepunchPayload, {
    ...v4HolepunchPayload(),
    addresses6: [{ host: '2001:db8::1', port: 4660 }],
    peerHasV6: true
  })
  t.not(state.buffer[0] & 64, 0, 'flag 64 set for a v6-advertising peer')

  const v4ByteLength = GOLDEN.holepunchPayload.length / 2
  t.is(
    state.buffer.subarray(0, v4ByteLength).toString('hex'),
    (0x3e | 64).toString(16) + GOLDEN.holepunchPayload.slice(2),
    'v4-era fields keep their exact layout; addresses6 is appended after them'
  )

  const { value, state: ds } = dec(m.holepunchPayload, state.buffer.toString('hex'))
  t.is(ds.start, ds.end, 'upgraded decoder consumes every byte')
  if (!value.addresses6 || value.addresses6.length !== 1) {
    t.fail('addresses6 did not round-trip (Phase 3 contract)')
    return
  }
  // current-truth: the ipv6 codec decodes hosts in UNCOMPRESSED form
  t.is(value.addresses6[0].host, '2001:db8:0:0:0:0:0:1')
  t.is(value.addresses6[0].port, 4660)
  t.is(value.addresses[0].host, '203.0.113.7', 'v4 addresses unaffected alongside')
})

test('golden: handshake v6 fields use flags 4/8 and round-trip', function (t) {
  const state = enc(m.handshake, {
    mode: 1,
    noise: b4a.from('deadbeef', 'hex'),
    peerAddress: null,
    relayAddress: null,
    peerAddress6: { host: '2001:db8::1', port: 4660 },
    relayAddress6: { host: '2001:db8::2', port: 30000 }
  })
  t.is(state.buffer[0] & 3, 0, 'v4 flags 1/2 absent when only v6 fields are set')
  t.not(state.buffer[0] & 4, 0, 'flag 4 = peerAddress6 (DESIGN §5.5)')
  t.not(state.buffer[0] & 8, 0, 'flag 8 = relayAddress6 (DESIGN §5.5)')

  const { value, state: ds } = dec(m.handshake, state.buffer.toString('hex'))
  t.is(ds.start, ds.end, 'decoder consumes the message exactly')
  t.is(value.mode, 1)
  t.is(value.peerAddress, null)
  t.is(value.relayAddress, null)
  if (!value.peerAddress6 || !value.relayAddress6) {
    t.fail('peerAddress6/relayAddress6 did not round-trip (Phase 3 contract)')
    return
  }
  t.is(value.peerAddress6.host, '2001:db8:0:0:0:0:0:1')
  t.is(value.peerAddress6.port, 4660)
  t.is(value.relayAddress6.host, '2001:db8:0:0:0:0:0:2')
  t.is(value.relayAddress6.port, 30000)
})

test('golden: server-shaped noisePayload (relayInfo) unchanged, version stays 1', function (t) {
  const state = enc(m.noisePayload, {
    error: 0,
    firewall: 2,
    holepunch: {
      id: 7,
      relays: [
        {
          relayAddress: { host: '203.0.113.1', port: 10001 },
          peerAddress: { host: '198.51.100.2', port: 20002 }
        }
      ]
    },
    addresses4: [{ host: '198.51.100.2', port: 20002 }],
    addresses6: [],
    udx: { reusableSocket: false, id: 1, seq: 0 },
    secretStream: {},
    relayThrough: null,
    relayAddresses: [{ host: '203.0.113.1', port: 10001 }]
  })
  t.is(state.buffer.toString('hex'), GOLDEN.serverShaped)
  t.is(state.buffer[0], 1, 'noisePayload.version stays 1 (no relayInfo encoding rev shipped)')
  t.is(state.buffer[1], 0x5b, 'flags 1|2|8|16|64, nothing above 64')
})
