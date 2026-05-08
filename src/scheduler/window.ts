// Returns true when the agent is allowed to run work (10:00–19:00 IST, Mon–Sat).
// Temporarily disabled for development — always returns true.
export function isWithinWorkWindow(): boolean {
  return true
}
