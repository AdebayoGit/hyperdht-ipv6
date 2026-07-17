// PHASE 2 CONTRACT — DESIGN.md §5.5 capability echo. RED until Phase 2 lands
// in upstream/hyperdht.
//
// DRAFT CONTRACT (subject to maintainer feedback on DESIGN.md §8 Q3 —
// capability echo vs version bump; update these pins first if that lands):
//
//   1. lib/messages.js exports `hasV6(payload)` — true iff a decoded
//      noisePayload advertised any v6 capability (non-empty addresses6 today;
//      any v6-era field later). This is the "echo": each side records it from
//      the peer's payload and gates what it sends back.
//   2. The echo is threaded through the encoder as a field on the payload
//      object itself: `m.peerHasV6` (boolean, default false). When false,
//      v6-era EXTENSION fields — anything behind flag bits >= 128, e.g. the
//      draft `relayAddresses6` — are omitted so a strict v4-era decoder
//      parses the bytes cleanly. (A field on `m` was chosen over an encode
//      option because compact-encoding codecs are (state, m) only.)
//   3. `addresses6` (flag 4) is exempt from gating: every version-1 decoder
//      in production already knows flag 4 (see 01-noise-golden pins).
//   4. `noisePayload.version` stays 1 in all cases — see the unknown-version
//      pin in 01: a bump would hard-abort every existing peer.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const m = require('../../upstream/hyperdht/lib/messages.js')
const { missing } = require('./helpers.js')

// ---------------------------------------------------------------------------
// FROZEN strict v4-era decoder — a literal replica of today's (pre-Phase-2)
// noisePayload.decode. DO NOT update this when messages.js changes: it stands
// in for every un-upgraded node on the network. "Strict" additions: it throws
// on version !== 1 and reports trailing bytes it did not understand.
// ---------------------------------------------------------------------------
const ipv4 = c.ipv4Address
const ipv4Array = c.array(ipv4)
const ipv6Array = c.array(c.ipv6Address)

const frozenRelayInfo = {
  decode (state) {
    return { relayAddress: ipv4.decode(state), peerAddress: ipv4.decode(state) }
  }
}
const frozenRelayInfoArray = c.array(frozenRelayInfo)

function frozenHolepunchInfo (state) {
  return { id: c.uint.decode(state), relays: frozenRelayInfoArray.decode(state) }
}

function frozenUdxInfo (state) {
  const version = c.uint.decode(state)
  const features = c.uint.decode(state)
  return { version, reusableSocket: (features & 1) !== 0, id: c.uint.decode(state), seq: c.uint.decode(state) }
}

function frozenSecretStreamInfo (state) {
  return { version: c.uint.decode(state) }
}

function frozenRelayThroughInfo (state) {
  const version = c.uint.decode(state)
  c.uint.decode(state)
  return { version, publicKey: c.fixed32.decode(state), token: c.fixed32.decode(state) }
}

function strictV4EraDecode (buffer) {
  const state = { start: 0, end: buffer.byteLength, buffer }
  const version = c.uint.decode(state)
  if (version !== 1) throw new Error('v4-era decoder: unsupported version ' + version)
  const flags = c.uint.decode(state)
  const payload = {
    version,
    error: c.uint.decode(state),
    firewall: c.uint.decode(state),
    holepunch: (flags & 1) !== 0 ? frozenHolepunchInfo(state) : null,
    addresses4: (flags & 2) !== 0 ? ipv4Array.decode(state) : [],
    addresses6: (flags & 4) !== 0 ? ipv6Array.decode(state) : [],
    udx: (flags & 8) !== 0 ? frozenUdxInfo(state) : null,
    secretStream: (flags & 16) !== 0 ? frozenSecretStreamInfo(state) : null,
    relayThrough: (flags & 32) !== 0 ? frozenRelayThroughInfo(state) : null,
    relayAddresses: (flags & 64) !== 0 ? ipv4Array.decode(state) : null
  }
  return { payload, flags, trailing: state.end - state.start }
}

function enc (codec, value) {
  const state = { start: 0, end: 0, buffer: null }
  codec.preencode(state, value)
  state.buffer = b4a.alloc(state.end)
  codec.encode(state, value)
  return state.buffer
}

// A realistic connect.js-shaped payload base, per the golden pins in 01.
function basePayload () {
  return {
    error: 0,
    firewall: 1,
    holepunch: null,
    addresses4: [{ host: '203.0.113.7', port: 4660 }],
    addresses6: [{ host: '2001:db8::1', port: 4660 }],
    udx: { reusableSocket: true, id: 42, seq: 0 },
    secretStream: {},
    relayThrough: null,
    relayAddresses: null
  }
}

const V6_EXTENSION = [{ host: '2001:db8::2', port: 30000 }] // draft relayAddresses6

test('messages exports a hasV6 capability detector', function (t) {
  if (missing(t, m.hasV6, 'messages.hasV6() (Phase 2 capability echo)')) return

  const v4Era = {
    version: 1,
    error: 0,
    firewall: 1,
    holepunch: null,
    addresses4: [{ host: '203.0.113.7', port: 4660 }],
    addresses6: [],
    udx: { reusableSocket: true, id: 42, seq: 0 },
    secretStream: { version: 1 },
    relayThrough: null,
    relayAddresses: null
  }
  t.is(m.hasV6(v4Era), false, 'a v4-era payload does not advertise v6')
  t.is(
    m.hasV6({ ...v4Era, addresses6: [{ host: '2001:db8::1', port: 1 }] }),
    true,
    'non-empty addresses6 is the v6 advertisement'
  )
})

test('v6-era flags are withheld from peers that did not advertise v6', function (t) {
  if (missing(t, m.hasV6, 'messages.hasV6() (Phase 2 capability echo)')) return

  const gated = enc(m.noisePayload, {
    ...basePayload(),
    relayAddresses6: V6_EXTENSION, // draft Phase 2/3 extension field
    peerHasV6: false // the peer's own payload carried no v6 — withhold
  })
  const plain = enc(m.noisePayload, basePayload())

  t.is(
    gated.toString('hex'),
    plain.toString('hex'),
    'payload for a non-v6 peer is byte-identical to one without v6 extensions'
  )
  t.is(gated[1] & 0x80, 0, 'no flag bits >= 128 for a non-v6 peer')
})

test('payload produced for a non-v6 peer parses cleanly with a strict v4-era decoder', function (t) {
  if (missing(t, m.hasV6, 'messages.hasV6() (Phase 2 capability echo)')) return

  const buffer = enc(m.noisePayload, {
    ...basePayload(),
    relayAddresses6: V6_EXTENSION,
    peerHasV6: false
  })

  const { payload, trailing } = strictV4EraDecode(buffer)
  t.is(trailing, 0, 'a v4-era decoder consumes every byte — nothing it cannot parse')
  t.is(payload.version, 1)
  t.is(payload.addresses4[0].host, '203.0.113.7')
  t.is(payload.addresses6.length, 1, 'flag 4 (addresses6) is NOT gated — v1 decoders already parse it')
  t.is(payload.udx.id, 42)
})

test('v6-era flags are emitted to peers that advertised v6, and only to them', function (t) {
  if (missing(t, m.hasV6, 'messages.hasV6() (Phase 2 capability echo)')) return

  const buffer = enc(m.noisePayload, {
    ...basePayload(),
    relayAddresses6: V6_EXTENSION,
    peerHasV6: true // the peer's payload advertised v6 — extensions allowed
  })

  t.not(buffer[1] & 0x80, 0, 'flag 128 (relayAddresses6, draft) set for a v6 peer')

  // The upgraded decoder round-trips the extension...
  const state = { start: 0, end: buffer.byteLength, buffer }
  const payload = m.noisePayload.decode(state)
  t.is(state.start, state.end, 'upgraded decoder consumes every byte')
  t.ok(payload.relayAddresses6 && payload.relayAddresses6.length === 1, 'relayAddresses6 round-trips')
  t.is(payload.relayAddresses6[0].port, 30000)

  // ...while the frozen v4-era decoder would be left with bytes it never
  // parses. This is exactly why the capability echo exists: these bytes are
  // harmless ONLY because they are never sent to such a peer.
  const { trailing } = strictV4EraDecode(buffer)
  t.ok(trailing > 0, 'v4-era decoder cannot fully consume a v6-extended payload (hence the gate)')
})

test('noisePayload.version stays 1 even when v6 fields are present', function (t) {
  if (missing(t, m.hasV6, 'messages.hasV6() (Phase 2 capability echo)')) return

  const withExt = enc(m.noisePayload, {
    ...basePayload(),
    relayAddresses6: V6_EXTENSION,
    peerHasV6: true
  })
  const withoutExt = enc(m.noisePayload, { ...basePayload(), peerHasV6: false })

  t.is(withExt[0], 1, 'version byte stays 1 with v6 extensions')
  t.is(withoutExt[0], 1, 'version byte stays 1 without them')
})
