// Returns true when the agent is allowed to run work (10:00–19:00 IST, Mon–Sat).
export function isWithinWorkWindow(): boolean {
  const now = new Date()
  // IST = UTC+5:30
  const istOffset = 5.5 * 60 // minutes
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const istMinutes = (utcMinutes + istOffset) % (24 * 60)
  const istDay = getISTDayOfWeek(now)

  if (istDay === 0) return false // Sunday

  const start = 10 * 60 // 10:00
  const end = 19 * 60   // 19:00
  return istMinutes >= start && istMinutes < end
}

function getISTDayOfWeek(utcDate: Date): number {
  const istOffset = 5.5 * 60 * 60 * 1000
  const istDate = new Date(utcDate.getTime() + istOffset)
  return istDate.getUTCDay()
}
