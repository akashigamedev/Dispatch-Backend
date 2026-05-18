import { Router } from 'express'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, githubProjects, tasks, taskLogs } from '../../db/index.js'
import { requestCancel, getCurrentTask } from '../../worker/cancel.js'
import { runWorkerTick } from '../../scheduler/worker.js'
import { findOrCreateRepo, parseLabels } from '../../scheduler/poller.js'
import { AppError } from '../../util/errors.js'

const router = Router()

const STARTABLE_STATUSES = ['done', 'failed', 'cancelled', 'awaiting_input'] as const

const startSchema = z.object({
  issueNodeId: z.string().min(1),
  issueNumber: z.number().int(),
  issueUrl: z.string().url(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  repoFullName: z.string().min(1),
  repoGithubId: z.number().int(),
  projectNodeId: z.string().min(1),
  labels: z.array(z.string()).default([]),
})

router.post('/tasks/start', requireAuth, async (req, res) => {
  const userId = req.user.id
  const parsed = startSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  const p = parsed.data

  // Verify the project is one of the user's enabled projects.
  const [project] = await db
    .select({ id: githubProjects.id })
    .from(githubProjects)
    .where(and(
      eq(githubProjects.user_id, userId),
      eq(githubProjects.project_node_id, p.projectNodeId),
      eq(githubProjects.enabled, true),
    ))
  if (!project) throw new AppError(400, 'project is not enabled for this user')

  const repoId = await findOrCreateRepo(userId, p.repoFullName, p.repoGithubId)
  if (!repoId) throw new AppError(500, 'failed to create repo')

  const { size, priority } = parseLabels(p.labels)

  // If a row already exists for this issue, requeue it; otherwise insert.
  const [existing] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.github_issue_node_id, p.issueNodeId)))

  let taskId: number
  if (existing) {
    if (!STARTABLE_STATUSES.includes(existing.status as (typeof STARTABLE_STATUSES)[number])) {
      throw new AppError(400, `task is already started or in flight (status: ${existing.status})`)
    }
    await db
      .update(tasks)
      .set({
        status: 'queued',
        title: p.title,
        body: p.body ?? null,
        size,
        priority,
        github_issue_url: p.issueUrl,
        github_project_node_id: p.projectNodeId,
        enqueued_at: new Date(),
        started_at: null,
        finished_at: null,
        failure_reason: null,
        branch_name: null,
        pr_url: null,
        pr_number: null,
      })
      .where(eq(tasks.id, existing.id))
    taskId = existing.id
  } else {
    const [inserted] = await db
      .insert(tasks)
      .values({
        user_id: userId,
        repo_id: repoId,
        github_issue_node_id: p.issueNodeId,
        github_issue_number: p.issueNumber,
        github_issue_url: p.issueUrl,
        github_project_node_id: p.projectNodeId,
        title: p.title,
        body: p.body ?? null,
        size,
        priority,
        status: 'queued',
      })
      .returning({ id: tasks.id })
    if (!inserted) throw new AppError(500, 'failed to create task')
    taskId = inserted.id
  }

  // Fire-and-forget — runs the next queued task if nothing else is in flight.
  runWorkerTick(userId).catch(() => { /* logged inside worker */ })

  res.json({ ok: true, taskId, status: 'queued' })
})

router.post('/tasks/:id/cancel', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')

  const activeStatuses = ['planning', 'coding', 'verifying', 'reviewing', 'pushing']
  if (!activeStatuses.includes(task.status)) {
    throw new AppError(400, `task is not running (status: ${task.status})`)
  }

  if (getCurrentTask() === taskId) {
    requestCancel(taskId)
    res.json({ ok: true, message: 'cancel requested' })
  } else {
    // Not currently running — mark directly
    await db.update(tasks).set({ status: 'cancelled', finished_at: new Date() }).where(eq(tasks.id, taskId))
    res.json({ ok: true, message: 'cancelled' })
  }
})

router.get('/tasks/:id/logs', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)
  const since = Number(req.query.since ?? 0)

  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')

  const logs = await db
    .select()
    .from(taskLogs)
    .where(and(eq(taskLogs.task_id, taskId), since > 0 ? gt(taskLogs.id, since) : sql`true`))
    .orderBy(asc(taskLogs.id))
    .limit(200)

  res.json({ logs })
})

export default router
