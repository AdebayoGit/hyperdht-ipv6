// Shared guard: while Phase 1 is unimplemented, dependent tests should
// FAIL (RED) with a clear message instead of crashing or hanging the run.
exports.missing = function missing (t, value, what, phase = 'Phase 1') {
  if (value !== undefined && value !== null) return false
  t.fail(`${what} not implemented yet (${phase} contract)`)
  return true
}
