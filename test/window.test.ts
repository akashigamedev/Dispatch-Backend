import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isWithinWorkWindow } from '../src/scheduler/window.js'

// All times are for IST (UTC+5:30) with profile: work 10:00–19:00, no Sundays.
// UTC equivalents: IST = UTC + 5h30m → UTC = IST − 5h30m

const IST = { work_start_local: '10:00', work_end_local: '19:00', timezone: 'Asia/Kolkata' }

// 2024-01-07 is a Sunday.
// 2024-01-08 is a Monday.
const SUN_1200_IST = new Date('2024-01-07T06:30:00Z')   // Sun 12:00 IST
const MON_0930_IST = new Date('2024-01-08T04:00:00Z')   // Mon 09:30 IST (before window)
const MON_1000_IST = new Date('2024-01-08T04:30:00Z')   // Mon 10:00 IST (window start)
const MON_1430_IST = new Date('2024-01-08T09:00:00Z')   // Mon 14:30 IST (midday)
const MON_1900_IST = new Date('2024-01-08T13:30:00Z')   // Mon 19:00 IST (window end — exclusive)
const MON_1901_IST = new Date('2024-01-08T13:31:00Z')   // Mon 19:01 IST (after window)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('isWithinWorkWindow', () => {
  it('returns false on Sunday', () => {
    vi.setSystemTime(SUN_1200_IST)
    expect(isWithinWorkWindow(IST)).toBe(false)
  })

  it('returns false before work start', () => {
    vi.setSystemTime(MON_0930_IST)
    expect(isWithinWorkWindow(IST)).toBe(false)
  })

  it('returns true at exactly work start', () => {
    vi.setSystemTime(MON_1000_IST)
    expect(isWithinWorkWindow(IST)).toBe(true)
  })

  it('returns true during work hours', () => {
    vi.setSystemTime(MON_1430_IST)
    expect(isWithinWorkWindow(IST)).toBe(true)
  })

  it('returns false at exactly work end (exclusive)', () => {
    vi.setSystemTime(MON_1900_IST)
    expect(isWithinWorkWindow(IST)).toBe(false)
  })

  it('returns false after work end', () => {
    vi.setSystemTime(MON_1901_IST)
    expect(isWithinWorkWindow(IST)).toBe(false)
  })

  it('respects custom work hours', () => {
    vi.setSystemTime(MON_0930_IST) // 09:30 IST
    const early = { ...IST, work_start_local: '09:00', work_end_local: '17:00' }
    expect(isWithinWorkWindow(early)).toBe(true)
  })

  it('respects a different timezone', () => {
    // 2024-01-08T02:30:00Z = 09:30 in Asia/Bangkok (UTC+7), before a 10:00 start
    vi.setSystemTime(new Date('2024-01-08T02:30:00Z'))
    const bkk = { work_start_local: '10:00', work_end_local: '19:00', timezone: 'Asia/Bangkok' }
    expect(isWithinWorkWindow(bkk)).toBe(false)
  })
})
