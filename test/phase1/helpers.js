// Shared guard: while Phase 1 is unimplemented, dependent tests should
// FAIL (RED) with a clear message instead of crashing or hanging the run.
exports.missing = function missing (t, value, what) {
  if (value !== undefined && value !== null) return false
  t.fail(`${what} not implemented yet (Phase 1 contract)`)
  return true
}
