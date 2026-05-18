import { eq, sql } from 'drizzle-orm'
import { db, profiles } from '../db/index.js'
import { log } from '../log.js'

export async function resetBudgetIfNewDay(userId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  const [profile] = await db
    .select({ resetDate: profiles.budget_reset_date, budget_enabled: profiles.budget_enabled })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  if (!profile?.budget_enabled || profile.resetDate >= today) return

  await db
    .update(profiles)
    .set({ spent_today_usd: '0.00', budget_reset_date: today })
    .where(eq(profiles.id, userId))

  log.info({ userId, today }, 'daily budget reset')
}

export async function isBudgetExceeded(userId: string): Promise<boolean> {
  const [profile] = await db
    .select({ spent: profiles.spent_today_usd, budget: profiles.daily_budget_usd, budget_enabled: profiles.budget_enabled })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  if (!profile?.budget_enabled) return false
  return parseFloat(profile.spent) >= parseFloat(profile.budget)
}

export async function addSpend(userId: string, costUsd: number): Promise<void> {
  const [profile] = await db
    .select({ budget_enabled: profiles.budget_enabled })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  if (!profile?.budget_enabled) return

  await db
    .update(profiles)
    .set({ spent_today_usd: sql`${profiles.spent_today_usd} + ${costUsd.toFixed(4)}` })
    .where(eq(profiles.id, userId))
}
