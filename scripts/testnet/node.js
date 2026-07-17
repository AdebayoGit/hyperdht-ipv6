#!/usr/bin/env node
'use strict'

// Long-running dual-stack dht-rpc node for the public IPv6 testnet
// (PLAN.md Phase 4b, VERIFICATION.md §4). Intended to run on a VPS under
// systemd (see README.md in this directory).
//
// Configuration (env var, or --flag which takes precedence):
//   FAMILIES  --families   comma list, 'ipv4,ipv6' (default) | 'ipv4' | 'ipv6'
//   HOST      --host       public IPv4 of this machine (bind + bootstrap seed)
//   HOST6     --host6      public IPv6 of this machine (bind + bootstrap seed)
//   PORT      --port       v4 UDP port (default 10001)
//   PORT6     --port6      v6 UDP port (default: same number as PORT)
//   BOOTSTRAP --bootstrap  comma list of host:port / [v6literal]:port entries.
//                          Empty (default) = run AS a bootstrap node, which
//                          requires HOST (and HOST6 when ipv6 is enabled) to
//                          be public address literals so the node can seed
//                          its own external address (like DHT.bootstrapper).
//   NAME      --name       label written into every stats record
//   INTERVAL  --interval   stats poll interval in seconds (default 60)
//   STATS_FILE --stats-file JSONL output path (default ./dht-stats.jsonl)
//
// The node is always non-ephemeral and firewalled:false. SIGINT/SIGTERM
// trigger a final stats sample and a clean dht.destroy().

const net = require('net')
const path = require('path')
const DHT = require('../../upstream/dht-rpc')

function parseArgv (argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[++i]
    } else {
      flags[arg.slice(2)] = 'true'
    }
  }
  return flags
}

function parseConfig (env = process.env, argv = process.argv.slice(2)) {
  const flags = parseArgv(argv)
  const get = (flag, envKey, dflt) => {
    if (flags[flag] !== undefined) return flags[flag]
    if (env[envKey] !== undefined && env[envKey] !== '') return env[envKey]
    return dflt
  }

  const families = String(get('families', 'FAMILIES', 'ipv4,ipv6'))
    .split(',').map(s => s.trim()).filter(Boolean)
  for (const f of families) {
    if (f !== 'ipv4' && f !== 'ipv6') throw new Error('Unknown family: ' + f)
  }

  const port = Number(get('port', 'PORT', 10001))
  const config = {
    families,
    host: get('host', 'HOST', null),
    host6: get('host6', 'HOST6', null),
    port,
    port6: Number(get('port6', 'PORT6', port)),
    bootstrap: String(get('bootstrap', 'BOOTSTRAP', ''))
      .split(',').map(s => s.trim()).filter(Boolean),
    name: get('name', 'NAME', 'testnet-node'),
    intervalMs: Number(get('interval', 'INTERVAL', 60)) * 1000,
    statsFile: get('stats-file', 'STATS_FILE', path.join(process.cwd(), 'dht-stats.jsonl'))
  }

  if (!Number.isInteger(config.port) || !Number.isInteger(config.port6)) {
    throw new Error('PORT/PORT6 must be integers')
  }
  if (config.host && !net.isIPv4(config.host)) throw new Error('HOST must be an IPv4 literal')
  if (config.host6 && !net.isIPv6(config.host6)) throw new Error('HOST6 must be an IPv6 literal')
  return config
}

function createNode (config) {
  const v4 = config.families.includes('ipv4')
  const v6 = config.families.includes('ipv6')

  const opts = {
    ephemeral: false,
    firewalled: false,
    anyPort: false,
    families: config.families,
    bootstrap: config.bootstrap.length > 0 ? config.bootstrap : []
  }
  if (v4) {
    opts.port = config.port
    if (config.host) opts.host = config.host
  }
  if (v6) {
    opts.port6 = config.port6
    if (config.host6) opts.host6 = config.host6
  }

  const dht = new DHT(opts)

  // Bootstrap-node mode: nobody will echo our external address back to us,
  // so seed the nat samplers ourselves. This mirrors DHT.bootstrapper(),
  // which only covers v4 - the v6 stack lives on the internal child DHT.
  if (opts.bootstrap.length === 0) {
    if (v4) {
      if (!config.host) throw new Error('Bootstrap mode requires HOST=<public IPv4>')
      dht._nat.add(config.host, config.port)
    }
    if (v6) {
      if (!config.host6) throw new Error('Bootstrap mode requires HOST6=<public IPv6>')
      const dht6 = dht.families.length === 1 ? dht : dht._dht6
      if (dht6 !== null) dht6._nat.add(config.host6, config.port6)
    }
  }

  return dht
}

function log (...parts) {
  process.stdout.write(`[${new Date().toISOString()}] ${parts.join(' ')}\n`)
}

async function main () {
  const config = parseConfig()
  const StatsLogger = require('./stats-logger.js')

  const dht = createNode(config)
  const logger = new StatsLogger(dht, {
    name: config.name,
    intervalMs: config.intervalMs,
    out: config.statsFile
  })

  dht.on('warning', (err) => log('warning:', err && err.message))
  dht.on('nat-update', (host, port) => log('nat-update:', `${host}:${port}`))
  dht.on('network-update', () => log('network-update:', `online=${dht.online} degraded=${dht.degraded}`))

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${signal} received, shutting down`)
    try { logger.stop() } catch (err) { log('logger stop failed:', err && err.message) }
    try {
      await dht.destroy()
    } catch (err) {
      log('destroy failed:', err && err.message)
      process.exitCode = 1
    }
    process.exit(process.exitCode || 0)
  }
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })

  log(`starting '${config.name}' families=${config.families.join('+')}`,
    config.bootstrap.length ? `bootstrap=${config.bootstrap.join(',')}` : '(bootstrap mode)')

  await dht.fullyBootstrapped()

  const addr4 = config.families.includes('ipv4') ? dht.address() : null
  const addr6 = dht.address6()
  log('bootstrapped.',
    addr4 ? `v4=${addr4.host}:${addr4.port}` : 'v4=off',
    addr6 ? `v6=[${addr6.host}]:${addr6.port}` : 'v6=off')
  log(`stats -> ${config.statsFile} every ${config.intervalMs / 1000}s`)

  logger.start()
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack}\n`)
    process.exit(1)
  })
}

module.exports = { parseConfig, createNode }
