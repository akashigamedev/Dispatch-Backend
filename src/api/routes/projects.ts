import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, githubProjects } from '../../db/index.js'
import { syncProjectsForUser } from '../../github/projectsSync.js'
import { AppError } from '../../util/errors.js'
import { log } from '../../log.js'

const router = Router()

router.get('/projects', requireAuth, async (req, res) => {
  const userId = req.user.id

  try {
    await syncProjectsForUser(userId)
  } catch (err) {
    log.error({ err, userId }, 'projects sync failed')
  }

  const rows = await db
    .select({
      id: githubProjects.id,
      projectNodeId: githubProjects.project_node_id,
      projectNumber: githubProjects.project_number,
      ownerLogin: githubProjects.owner_login,
      title: githubProjects.title,
      enabled: githubProjects.enabled,
    })
    .from(githubProjects)
    .where(eq(githubProjects.user_id, userId))

  res.json({ projects: rows })
})

const projectUpdateSchema = z.object({
  enabled: z.boolean(),
})

router.put('/projects/:id', requireAuth, async (req, res) => {
  const userId = req.user.id
  const projectId = Number(req.params.id)

  const parsed = projectUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }

  const [existing] = await db
    .select({ id: githubProjects.id })
    .from(githubProjects)
    .where(and(eq(githubProjects.id, projectId), eq(githubProjects.user_id, userId)))

  if (!existing) throw new AppError(404, 'project not found')

  await db.update(githubProjects).set({ enabled: parsed.data.enabled }).where(eq(githubProjects.id, projectId))
  res.json({ ok: true })
})

export default router
