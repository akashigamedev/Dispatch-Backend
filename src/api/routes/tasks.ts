import { Router } from 'express'
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, tasks, taskLogs } from '../../db/index.js'
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
      or(isNull(tasks.manual_order), asc(tasks.manual_order))!,
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

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')

  res.json(task)
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
