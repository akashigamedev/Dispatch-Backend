import { Router } from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, githubProjects, repos, tasks } from '../../db/index.js'
import { AppError } from '../../util/errors.js'
import { runWorkerTick } from '../../scheduler/worker.js'
import type { TaskRepoEntry } from '../../types/multiRepo.js'

const router = Router()

const createMultiSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  repoIds: z.array(z.number().int()).min(1).max(8),
  projectNodeId: z.string().min(1),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullish(),
  priority: z.number().int().nullish(),
  start: z.boolean().default(true),
})

router.post('/tasks/createMulti', requireAuth, async (req, res) => {
  const userId = req.user.id
  const parsed = createMultiSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  const p = parsed.data

  // Verify project belongs to user and is enabled.
  const [project] = await db
    .select({ id: githubProjects.id })
    .from(githubProjects)
    .where(and(
      eq(githubProjects.user_id, userId),
      eq(githubProjects.project_node_id, p.projectNodeId),
      eq(githubProjects.enabled, true),
    ))
  if (!project) throw new AppError(400, 'project is not enabled for this user')

  // Verify every repoId belongs to this user.
  const rows = await db
    .select({ id: repos.id, full_name: repos.full_name, base_branch: repos.base_branch })
    .from(repos)
    .where(and(eq(repos.user_id, userId), inArray(repos.id, p.repoIds)))
  if (rows.length !== p.repoIds.length) {
    throw new AppError(400, 'one or more repoIds do not belong to this user')
  }

  // Deduplicate repoIds while preserving the user's chosen ordering.
  const seen = new Set<number>()
  const orderedIds: number[] = []
  for (const id of p.repoIds) {
    if (!seen.has(id)) {
      seen.add(id)
      orderedIds.push(id)
    }
  }

  const repoEntries: TaskRepoEntry[] = orderedIds.map((id) => {
    const r = rows.find((x) => x.id === id)!
    return {
      repo_id: id,
      full_name: r.full_name,
      base_branch: r.base_branch,
      depends_on: [],
      status: 'pending' as const,
    }
  })

  const [inserted] = await db
    .insert(tasks)
    .values({
      user_id: userId,
      kind: 'multi',
      title: p.title,
      body: p.description,
      description: p.description,
      project_node_id_target: p.projectNodeId,
      repos: repoEntries,
      size: p.size,
      priority: p.priority ?? 0,
      status: p.start ? 'queued' : 'awaiting_input',
    })
    .returning({ id: tasks.id })

  if (!inserted) throw new AppError(500, 'failed to create task')

  if (p.start) {
    runWorkerTick(userId).catch(() => { /* logged inside worker */ })
  }

  res.json({ ok: true, taskId: inserted.id, status: p.start ? 'queued' : 'awaiting_input' })
})

export default router
