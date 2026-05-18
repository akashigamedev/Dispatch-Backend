import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, profiles } from '../../db/index.js'

const router = Router()

const modelConfigSchema = z.object({
  id: z.string().optional(),
  thinking: z.string().optional(),
})

const modelsSchema = z.object({
  planner: modelConfigSchema.optional(),
  coder: modelConfigSchema.optional(),
  sizer: modelConfigSchema.optional(),
  reviewer: modelConfigSchema.optional(),
})

const settingsUpdateSchema = z.object({
  workStartLocal: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  workEndLocal: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
  dailyBudgetUsd: z.number().positive().max(1000).optional(),
  budgetEnabled: z.boolean().optional(),
  models: modelsSchema.optional(),
})

router.get('/settings', requireAuth, async (req, res) => {
  const [profile] = await db
    .select({
      workStartLocal: profiles.work_start_local,
      workEndLocal: profiles.work_end_local,
      timezone: profiles.timezone,
      dailyBudgetUsd: profiles.daily_budget_usd,
      spentTodayUsd: profiles.spent_today_usd,
      budgetEnabled: profiles.budget_enabled,
      models: profiles.models,
    })
    .from(profiles)
    .where(eq(profiles.id, req.user.id))
    .limit(1)

  if (!profile) {
    res.status(404).json({ error: 'profile not found' })
    return
  }

  res.json(profile)
})

router.put('/settings', requireAuth, async (req, res) => {
  const parsed = settingsUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }

  const { workStartLocal, workEndLocal, timezone, dailyBudgetUsd, budgetEnabled, models } = parsed.data

  const patch: Record<string, unknown> = {}
  if (workStartLocal !== undefined) patch.work_start_local = workStartLocal
  if (workEndLocal !== undefined) patch.work_end_local = workEndLocal
  if (timezone !== undefined) patch.timezone = timezone
  if (dailyBudgetUsd !== undefined) patch.daily_budget_usd = dailyBudgetUsd.toFixed(2)
  if (budgetEnabled !== undefined) patch.budget_enabled = budgetEnabled

  if (models !== undefined) {
    const [current] = await db
      .select({ models: profiles.models })
      .from(profiles)
      .where(eq(profiles.id, req.user.id))
      .limit(1)

    const currentModels = (current?.models ?? {}) as Record<string, Record<string, string>>
    const mergedModels: Record<string, Record<string, string>> = { ...currentModels }
    for (const role of ['planner', 'coder', 'sizer', 'reviewer'] as const) {
      if (models[role] !== undefined) {
        mergedModels[role] = { ...(currentModels[role] ?? {}), ...models[role] }
      }
    }
    patch.models = mergedModels
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'no fields to update' })
    return
  }

  await db.update(profiles).set(patch).where(eq(profiles.id, req.user.id))

  res.json({ ok: true })
})

export default router
