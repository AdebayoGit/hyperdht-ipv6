// Phase 3 shares the phase1 missing() guard (single source of truth) and the
// phase2 timeout guard so RED integration tests fail with a clear assertion
// instead of hanging the runner.
const { once } = require('events')
const phase1 = require('../phase1/helpers.js')
const phase2 = require('../phase2/helpers.js')

function missing (t, value, what) {
  return phase1.missing(t, value, what, 'Phase 3')
}

// Never-rejecting 'open' wait. brittle does not catch async throws from test
// bodies, so a rejected `once(socket, 'open')` (socket errored while RED)
// would crash the whole runner instead of failing the test. Resolves null on
// open, the Error on failure.
function opened (socket) {
  return once(socket, 'open').then(
    () => null,
    (err) => err || new Error('socket closed before open')
  )
}

module.exports = {
  missing,
  opened,
  withTimeout: phase2.withTimeout,
  TIMEOUT: phase2.TIMEOUT
}
