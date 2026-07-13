import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, githubProjects, repos, tasks } from '../../db/index.js'
import { AppError } from '../../util/errors.js'
import { runWorkerTick } from '../../scheduler/worker.js'
import { findOrCreateRepo } from '../../scheduler/poller.js'
import type { TaskRepoEntry } from '../../types/multiRepo.js'
import { log } from '../../log.js'

const router = Router()

const repoRefSchema = z.object({
  repoGithubId: z.number().int(),
  fullName: z.string().trim().min(1),
})

const createMultiSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  repos: z.array(repoRefSchema).min(1).max(8),
  projectNodeId: z.string().min(1),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullish(),
  priority: z.number().int().nullish(),
  start: z.boolean().default(true),
})

router.post('/tasks/createMulti', requireAuth, async (req, res) => {
  const userId = req.user.id
  const parsed = createMultiSchema.safeParse(req.body)
  if (!parsed.success) {
    log.warn({ body: req.body, issues: parsed.error.flatten() }, 'createMulti validation failed')
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

  // Deduplicate repos while preserving the user's chosen ordering.
  const seen = new Set<number>()
  const orderedRepos = p.repos.filter((r) => {
    if (seen.has(r.repoGithubId)) return false
    seen.add(r.repoGithubId)
    return true
  })

  const repoEntries: TaskRepoEntry[] = []
  for (const r of orderedRepos) {
    const repoId = await findOrCreateRepo(userId, r.fullName, r.repoGithubId)
    if (!repoId) throw new AppError(500, 'failed to create repo')
    const [row] = await db
      .select({ base_branch: repos.base_branch })
      .from(repos)
      .where(eq(repos.id, repoId))
    repoEntries.push({
      repo_id: repoId,
      full_name: r.fullName,
      base_branch: row?.base_branch ?? 'dev',
      depends_on: [],
      status: 'pending' as const,
    })
  }

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
