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
  models: modelsSchema.optional(),
})

router.get('/settings', requireAuth, async (req, res) => {
  const [profile] = await db
    .select({ models: profiles.models })
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

  const { models } = parsed.data
  if (models === undefined) {
    res.status(400).json({ error: 'no fields to update' })
    return
  }

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

  await db.update(profiles).set({ models: mergedModels }).where(eq(profiles.id, req.user.id))

  res.json({ ok: true })
})

export default router
