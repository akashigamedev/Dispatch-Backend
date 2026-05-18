import { Router } from 'express'
import { and, asc, desc, eq, gt, min, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, tasks, taskLogs } from '../../db/index.js'
import { requestCancel, getCurrentTask } from '../../worker/cancel.js'
import { AppError } from '../../util/errors.js'

const router = Router()

router.get('/tasks', requireAuth, async (req, res) => {
  const userId = req.user.id
  const status = req.query.status as string | undefined
  const limit = Math.min(Number(req.query.limit ?? 50), 100)
  const cursor = Number(req.query.cursor ?? 0)

  const where = and(
    eq(tasks.user_id, userId),
    status ? eq(tasks.status, status as never) : undefined,
    cursor > 0 ? gt(tasks.id, cursor) : undefined,
  )

  const rows = await db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(
      sql`${tasks.manual_order} asc nulls last`,
      desc(tasks.priority),
      asc(tasks.size),
      asc(tasks.enqueued_at),
    )
    .limit(limit)

  res.json({
    tasks: rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      size: t.size,
      priority: t.priority,
      githubIssueUrl: t.github_issue_url,
      githubIssueNumber: t.github_issue_number,
      branchName: t.branch_name,
      prUrl: t.pr_url,
      enqueuedAt: t.enqueued_at,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
      costUsd: t.cost_usd,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
  })
})

router.get('/tasks/:id', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!t) throw new AppError(404, 'task not found')

  res.json({
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    size: t.size,
    priority: t.priority,
    githubIssueUrl: t.github_issue_url,
    githubIssueNumber: t.github_issue_number,
    branchName: t.branch_name,
    prUrl: t.pr_url,
    prNumber: t.pr_number,
    planMd: t.plan_md,
    diffSummary: t.diff_summary,
    failureReason: t.failure_reason,
    costUsd: t.cost_usd,
    tokensIn: t.tokens_in,
    tokensOut: t.tokens_out,
    enqueuedAt: t.enqueued_at,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
  })
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

router.post('/tasks/:id/pause', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')
  if (task.status !== 'queued') throw new AppError(400, `task is not queued (status: ${task.status})`)

  await db.update(tasks).set({ status: 'paused' }).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

router.post('/tasks/:id/resume', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')
  if (task.status !== 'paused') throw new AppError(400, `task is not paused (status: ${task.status})`)

  await db.update(tasks).set({ status: 'queued' }).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

router.post('/tasks/:id/skip', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')
  if (!['queued', 'paused'].includes(task.status)) {
    throw new AppError(400, `task cannot be skipped (status: ${task.status})`)
  }

  await db.update(tasks).set({ status: 'skipped', finished_at: new Date() }).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

router.post('/tasks/:id/requeue', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')
  const requeueableStatuses = ['done', 'failed', 'skipped', 'awaiting_input', 'cancelled']
  if (!requeueableStatuses.includes(task.status)) {
    throw new AppError(400, `task cannot be requeued (status: ${task.status})`)
  }

  await db.update(tasks).set({
    status: 'queued',
    finished_at: null,
    started_at: null,
    failure_reason: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
  }).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

const reorderSchema = z.object({
  orderedIds: z.array(z.number().int()).min(1),
})

router.post('/tasks/reorder', requireAuth, async (req, res) => {
  const userId = req.user.id
  const parsed = reorderSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }

  const { orderedIds } = parsed.data

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(tasks)
        .set({ manual_order: i })
        .where(and(eq(tasks.id, orderedIds[i]!), eq(tasks.user_id, userId)))
    }
  })

  res.json({ ok: true })
})

router.post('/tasks/:id/move_to_top', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)

  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')

  const [agg] = await db
    .select({ minOrder: min(tasks.manual_order) })
    .from(tasks)
    .where(eq(tasks.user_id, userId))

  const currentMin = agg?.minOrder ?? null
  const newOrder = currentMin !== null ? currentMin - 1 : 0

  await db.update(tasks).set({ manual_order: newOrder }).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

export default router
