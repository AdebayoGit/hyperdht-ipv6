// GOLDEN hyperdht WIRE PINS — DESIGN.md §5.5 / goal 1: "An un-upgraded node
// never sees a byte it doesn't already parse."
//
// These tests pass against UNMODIFIED hyperdht lib/messages.js and must keep
// passing, byte-for-byte, after Phases 2–3 for every v4-era-shaped payload.
// Any failure here means the handshake wire format regressed and the change
// must be rejected.
//
// Fixture values generated from hyperdht@6.33.x (upstream clone at commit
// ac6eaa5), BEFORE any IPv6 work. Do not regenerate; that would defeat the pin.

const test = require('brittle')
const b4a = require('b4a')
const m = require('../../upstream/hyperdht/lib/messages.js')

const GOLDEN = {
  // {version:1, flags:0, error:0, firewall:UNKNOWN} — no optional fields
  minimal: '01000000',

  // Exactly what lib/connect.js sends today: addresses4 + udx + secretStream,
  // addresses6 hard-coded to []. flags 0x1a = 2|8|16 — NO bit 4.
  // 01 (version) 1a (flags) 00 (error) 01 (firewall OPEN)
  // 02 cb007107 3412 c0a8010a 3412       addresses4: 203.0.113.7:4660, 192.168.1.10:4660
  // 01 01 2a 00                          udx: version 1, features 1 (reusable), id 42, seq 0
  // 01                                   secretStream: version 1
  clientShaped: '011a000102cb0071073412c0a8010a341201012a0001',

  // Server-shaped reply: holepunch info + addresses4 + udx + secretStream +
  // relayAddresses. flags 0x5b = 1|2|8|16|64 — top bit space (128+) unused.
  serverShaped: '015b00020701cb0071011127c6336402224e01c6336402224e010001000101cb0071011127',

  // addresses6 populated — flag 4 and the ipv6Array codec ALREADY exist today
  // (residue of holepunchto/hyperdht#93). Phase 2 only starts populating the
  // field; the byte layout is pinned here and must not change.
  // 01 (version) 04 (flags) 00 00 | 01 20010db8..0001 (16B host) 3412 (LE port)
  withV6: '010400000120010db80000000000000000000000013412',

  // handshake message: flags 3 (peerAddress|relayAddress), mode 2, 4B noise,
  // two 6-byte v4 addresses. Phase 3 claims flags 4/8 — this v4-era shape
  // must stay identical.
  handshake: '030204deadbeef010203043412050607083075',

  // holepunchPayload: flags 0x3e = punching|addresses|remoteAddress|token|
  // remoteToken. Phase 3 claims flag 64 — this v4-era shape must stay identical.
  holepunchPayload: '3e00020301cb0071073412c6336402224e' + '01'.repeat(32) + '02'.repeat(32)
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

test('golden: minimal noisePayload encodes byte-identically to today', function (t) {
  const state = enc(m.noisePayload, {
    error: 0,
    firewall: 0, // FIREWALL.UNKNOWN
    holepunch: null,
    addresses4: [],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  })
  t.is(state.buffer.toString('hex'), GOLDEN.minimal)
  t.is(state.buffer[0], 1, 'version byte is 1')
  t.is(state.buffer[1], 0, 'flags byte is 0')
})

test('golden: connect.js-shaped payload with addresses6: [] never sets flag 4', function (t) {
  const state = enc(m.noisePayload, {
    error: 0, // ERROR.NONE
    firewall: 1, // FIREWALL.OPEN
    holepunch: null,
    addresses4: [
      { host: '203.0.113.7', port: 4660 },
      { host: '192.168.1.10', port: 4660 }
    ],
    addresses6: [], // hard-coded [] in lib/connect.js today — flag-4-absent case
    udx: { reusableSocket: true, id: 42, seq: 0 },
    secretStream: {},
    relayThrough: null
  })
  t.is(state.buffer.toString('hex'), GOLDEN.clientShaped)
  t.is(state.buffer[1] & 4, 0, 'empty addresses6 encodes as absent flag 4')
  t.is(state.buffer[1] & 0x80, 0, 'flag 128 (future relayAddresses6) unused')
})

test('golden: server-shaped payload (holepunch + relayAddresses) is unchanged', function (t) {
  const state = enc(m.noisePayload, {
    error: 0,
    firewall: 2, // FIREWALL.CONSISTENT
    holepunch: {
      id: 7,
      relays: [{
        relayAddress: { host: '203.0.113.1', port: 10001 },
        peerAddress: { host: '198.51.100.2', port: 20002 }
      }]
    },
    addresses4: [{ host: '198.51.100.2', port: 20002 }],
    addresses6: [],
    udx: { reusableSocket: false, id: 1, seq: 0 },
    secretStream: {},
    relayThrough: null,
    relayAddresses: [{ host: '203.0.113.1', port: 10001 }]
  })
  t.is(state.buffer.toString('hex'), GOLDEN.serverShaped)
  t.is(state.buffer[1], 0x5b, 'flags 1|2|8|16|64, nothing above 64')
})

test('golden: populated addresses6 encodes as flag 4 with the existing ipv6 codec', function (t) {
  // The codec exists TODAY — Phase 2 only starts feeding it real addresses.
  // Its byte layout (16B big-endian host + LE uint16 port per entry) is pinned.
  const state = enc(m.noisePayload, {
    error: 0,
    firewall: 0,
    holepunch: null,
    addresses4: [],
    addresses6: [{ host: '2001:db8::1', port: 4660 }],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  })
  t.is(state.buffer.toString('hex'), GOLDEN.withV6)
  t.is(state.buffer[1], 4, 'flag 4 set, no other flags')

  const { value } = dec(m.noisePayload, GOLDEN.withV6)
  t.is(value.addresses6.length, 1)
  // NOTE current-truth pin: hyperdht's compact-encoding decodes v6 hosts in
  // UNCOMPRESSED form ('2001:db8:0:0:0:0:0:1', not '2001:db8::1'). Phase 2
  // address handling must compare v6 hosts canonically, not by string equality.
  t.is(value.addresses6[0].host, '2001:db8:0:0:0:0:0:1')
  t.is(value.addresses6[0].port, 4660)
})

test('golden: handshake message bytes are unchanged (flags 1|2 only)', function (t) {
  const state = enc(m.handshake, {
    mode: 2,
    noise: b4a.from('deadbeef', 'hex'),
    peerAddress: { host: '1.2.3.4', port: 4660 },
    relayAddress: { host: '5.6.7.8', port: 30000 }
  })
  t.is(state.buffer.toString('hex'), GOLDEN.handshake)
  t.is(state.buffer[0] & ~3, 0, 'no handshake flags beyond 1|2 (4/8 reserved for Phase 3)')

  const { value, state: ds } = dec(m.handshake, GOLDEN.handshake)
  t.is(value.mode, 2)
  t.is(value.peerAddress.host, '1.2.3.4')
  t.is(value.relayAddress.port, 30000)
  t.is(ds.start, ds.end, 'decoder consumes the message exactly')
})

test('golden: holepunchPayload bytes are unchanged (flag 64 stays free)', function (t) {
  const state = enc(m.holepunchPayload, {
    error: 0,
    firewall: 2,
    round: 3,
    connected: false,
    punching: true,
    addresses: [{ host: '203.0.113.7', port: 4660 }],
    remoteAddress: { host: '198.51.100.2', port: 20002 },
    token: b4a.alloc(32, 1),
    remoteToken: b4a.alloc(32, 2)
  })
  t.is(state.buffer.toString('hex'), GOLDEN.holepunchPayload)
  t.is(state.buffer[0] & 64, 0, 'flag 64 (future addresses6) unused today')

  const { value, state: ds } = dec(m.holepunchPayload, GOLDEN.holepunchPayload)
  t.is(value.round, 3)
  t.is(value.punching, true)
  t.is(value.addresses[0].host, '203.0.113.7')
  t.is(ds.start, ds.end, 'decoder consumes the payload exactly')
})

test('golden: strict decode of a v4-era payload yields addresses6 === []', function (t) {
  const { value, state } = dec(m.noisePayload, GOLDEN.clientShaped)
  t.is(state.start, state.end, 'every byte consumed — nothing trailing')
  t.is(value.version, 1)
  t.is(value.error, 0)
  t.is(value.firewall, 1)
  t.alike(value.addresses6, [], 'absent flag 4 decodes to empty addresses6')
  t.is(value.addresses4.length, 2)
  t.is(value.addresses4[0].host, '203.0.113.7')
  t.is(value.udx.id, 42)
  t.is(value.udx.reusableSocket, true)
  t.ok(value.secretStream)
  t.is(value.relayThrough, null)
})

test('golden: unknown noisePayload version short-circuits to safe defaults', function (t) {
  // Load-bearing for the "version stays 1" contract: if we ever bumped the
  // version, every current peer would hit this branch and abort the handshake
  // (connect.js: payload.version !== 1 → SERVER_INCOMPATIBLE). This pin is
  // why Phase 2 uses a capability echo instead of a version bump.
  const buffer = b4a.from('02ff', 'hex')
  const state = { start: 0, end: buffer.byteLength, buffer }
  const value = m.noisePayload.decode(state)
  t.is(value.version, 2)
  t.is(value.udx, null)
  t.alike(value.addresses4, [])
  t.alike(value.addresses6, [])
  t.is(state.start, 1, 'decoder does not attempt to parse past an unknown version')
})
