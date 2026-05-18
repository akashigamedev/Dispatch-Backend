export interface WorkWindowProfile {
  work_start_local: string  // "HH:MM" or "HH:MM:SS"
  work_end_local: string
  timezone: string
}

function parseHHMM(t: string): { hours: number; minutes: number } {
  const [h, m] = t.split(':').map(Number)
  return { hours: h ?? 0, minutes: m ?? 0 }
}

export function isWithinWorkWindow(profile: WorkWindowProfile): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: profile.timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))

  if (parts.weekday === 'Sun') return false

  const currentMinutes = parseInt(parts.hour === '24' ? '0' : parts.hour) * 60 + parseInt(parts.minute)
  const { hours: startH, minutes: startM } = parseHHMM(profile.work_start_local)
  const { hours: endH, minutes: endM } = parseHHMM(profile.work_end_local)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  return currentMinutes >= startMinutes && currentMinutes < endMinutes
}
