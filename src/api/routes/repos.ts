import { Router } from 'express'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, repos } from '../../db/index.js'
import { AppError } from '../../util/errors.js'

const router = Router()

router.get('/repos', requireAuth, async (req, res) => {
  const userId = req.user.id

  const rows = await db
    .select({
      id: repos.id,
      fullName: repos.full_name,
      baseBranch: repos.base_branch,
      branchPrefix: repos.branch_prefix,
      allowed: repos.allowed,
    })
    .from(repos)
    .where(eq(repos.user_id, userId))
    .orderBy(asc(repos.full_name))

  res.json({ repos: rows })
})

const repoUpdateSchema = z.object({
  allowed: z.boolean().optional(),
  baseBranch: z.string().min(1).max(255).optional(),
})

router.put('/repos/:id', requireAuth, async (req, res) => {
  const userId = req.user.id
  const repoId = Number(req.params.id)

  const parsed = repoUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }

  const [existing] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.user_id, userId)))

  if (!existing) throw new AppError(404, 'repo not found')

  const { allowed, baseBranch } = parsed.data
  const patch: Record<string, unknown> = {}
  if (allowed !== undefined) patch.allowed = allowed
  if (baseBranch !== undefined) patch.base_branch = baseBranch

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'no fields to update' })
    return
  }

  await db.update(repos).set(patch).where(eq(repos.id, repoId))
  res.json({ ok: true })
})

export default router
