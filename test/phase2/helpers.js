// Phase 2 shares the phase1 missing() guard (single source of truth) and adds
// an async timeout guard so RED integration tests fail with a clear assertion
// instead of hanging the runner.
const phase1 = require('../phase1/helpers.js')

// Same guard, labeled for this phase. Note: several Phase 2 tests guard on
// surface that is itself Phase 1 contract (table6/address6 on dht-rpc) —
// the label reflects which suite is failing, not where the fix lands.
function missing (t, value, what) {
  return phase1.missing(t, value, what, 'Phase 2')
}

const TIMEOUT = Symbol('phase2-timeout')

// Race a promise against a timer. Returns TIMEOUT if the timer wins so the
// caller can t.fail() cleanly. Promise.race keeps a handler attached to the
// losing promise, so a late rejection never becomes an unhandled rejection.
async function withTimeout (promise, ms) {
  let timer = null
  const guard = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMEOUT) })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { missing, withTimeout, TIMEOUT }
