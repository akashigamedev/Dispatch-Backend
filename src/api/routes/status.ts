import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, profiles } from '../../db/index.js'
import { env } from '../../env.js'

const router = Router()

router.get('/status', requireAuth, async (req, res) => {
  const userId = req.user.id
  const meta = (req.user.user_metadata ?? {}) as Record<string, unknown>

  // Upsert profile on first sign-in; GitHub OAuth metadata carries github_login / github_user_id.
  await db
    .insert(profiles)
    .values({
      id: userId,
      github_login: String(meta.user_name ?? meta.preferred_username ?? ''),
      github_user_id: Number(meta.provider_id ?? meta.sub ?? 0),
      budget_reset_date: new Date().toISOString().split('T')[0],
    })
    .onConflictDoNothing()

  const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId))
  if (!profile) {
    res.status(500).json({ error: 'profile not found after upsert' })
    return
  }

  const githubAuth: 'pat' | 'app_installed' | 'none' = profile.github_installation_id
    ? 'app_installed'
    : env.GITHUB_PAT
      ? 'pat'
      : 'none'

  res.json({
    active: profile.active,
    githubAuth,
    setupComplete: githubAuth !== 'none',
    profile: {
      githubLogin: profile.github_login,
      timezone: profile.timezone,
      workStart: profile.work_start_local,
      workEnd: profile.work_end_local,
      dailyBudgetUsd: profile.daily_budget_usd,
      spentTodayUsd: profile.spent_today_usd,
    },
  })
})

export default router
