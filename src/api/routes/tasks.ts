import { Router } from 'express'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { db, githubProjects, repos, tasks, taskLogs } from '../../db/index.js'
import { requestCancel, getCurrentTask } from '../../worker/cancel.js'
import { runWorkerTick } from '../../scheduler/worker.js'
import { findOrCreateRepo, parseLabels } from '../../scheduler/poller.js'
import { AppError } from '../../util/errors.js'
import { createIssueAndAddToProject } from '../../github/createIssue.js'
import { getPRState, postPRComment } from '../../github/pulls.js'
import { getIssueProjectStatus, setIssueProjectStatus } from '../../github/issueStatus.js'
import { log } from '../../log.js'

const router = Router()

const STARTABLE_STATUSES = ['failed', 'cancelled', 'awaiting_input'] as const

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

const fieldValueSchema = z.object({
  fieldId: z.string().min(1),
  singleSelectOptionId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  text: z.string().optional(),
  number: z.number().optional(),
  iterationId: z.string().optional(),
}).refine(
  (v) =>
    [v.singleSelectOptionId, v.date, v.text, v.number, v.iterationId].filter((x) => x !== undefined)
      .length === 1,
  { message: 'each fieldValue must set exactly one of singleSelectOptionId/date/text/number/iterationId' },
)

const createSchema = z.object({
  repoFullName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional().nullable(),
  projectNodeId: z.string().min(1),
  fieldValues: z.array(fieldValueSchema).default([]),
  start: z.boolean().default(false),
})

router.post('/tasks/create', requireAuth, async (req, res) => {
  const userId = req.user.id
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  const p = parsed.data

  const [project] = await db
    .select({ id: githubProjects.id })
    .from(githubProjects)
    .where(and(
      eq(githubProjects.user_id, userId),
      eq(githubProjects.project_node_id, p.projectNodeId),
      eq(githubProjects.enabled, true),
    ))
  if (!project) throw new AppError(400, 'project is not enabled for this user')

  const created = await createIssueAndAddToProject({
    repoFullName: p.repoFullName,
    title: p.title,
    body: p.body ?? null,
    projectNodeId: p.projectNodeId,
    fieldValues: p.fieldValues,
  })

  const repoId = await findOrCreateRepo(userId, p.repoFullName, created.repoGithubId)
  if (!repoId) throw new AppError(500, 'failed to create repo')

  if (!p.start) {
    res.json({
      ok: true,
      issueNumber: created.issueNumber,
      issueUrl: created.issueUrl,
      taskId: null,
    })
    return
  }

  const [inserted] = await db
    .insert(tasks)
    .values({
      user_id: userId,
      repo_id: repoId,
      github_issue_node_id: created.issueNodeId,
      github_issue_number: created.issueNumber,
      github_issue_url: created.issueUrl,
      github_project_node_id: p.projectNodeId,
      title: p.title,
      body: p.body ?? null,
      status: 'queued',
    })
    .returning({ id: tasks.id })
  if (!inserted) throw new AppError(500, 'failed to insert task')

  runWorkerTick(userId).catch(() => { /* logged inside worker */ })

  res.json({
    ok: true,
    issueNumber: created.issueNumber,
    issueUrl: created.issueUrl,
    taskId: inserted.id,
  })
})

const QUEUED_STATUSES = [
  'queued',
  'planning',
  'awaiting_input',
  'coding',
  'verifying',
  'reviewing',
  'pushing',
] as const

const COMPLETED_STATUSES = ['done', 'failed', 'cancelled'] as const

// Lower rank = shown first. Active phases pin to the top of the Queued tab.
const QUEUED_STATUS_RANK_SQL = sql`case ${tasks.status}
  when 'planning' then 0
  when 'coding' then 0
  when 'verifying' then 0
  when 'reviewing' then 0
  when 'pushing' then 0
  when 'queued' then 1
  when 'awaiting_input' then 2
  else 3
end`

router.get('/tasks', requireAuth, async (req, res) => {
  const userId = req.user.id
  const bucket = req.query.bucket === 'completed' ? 'completed' : 'queued'

  const statuses = bucket === 'completed' ? COMPLETED_STATUSES : QUEUED_STATUSES

  const baseSelect = {
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    size: tasks.size,
    priority: tasks.priority,
    githubIssueNodeId: tasks.github_issue_node_id,
    githubIssueNumber: tasks.github_issue_number,
    githubIssueUrl: tasks.github_issue_url,
    repoFullName: repos.full_name,
    prUrl: tasks.pr_url,
    prNumber: tasks.pr_number,
    enqueuedAt: tasks.enqueued_at,
    startedAt: tasks.started_at,
    finishedAt: tasks.finished_at,
    failureReason: tasks.failure_reason,
  }

  const rows = bucket === 'completed'
    ? await db
        .select(baseSelect)
        .from(tasks)
        .leftJoin(repos, eq(repos.id, tasks.repo_id))
        .where(and(eq(tasks.user_id, userId), inArray(tasks.status, [...statuses])))
        .orderBy(desc(tasks.finished_at))
        .limit(100)
    : await db
        .select(baseSelect)
        .from(tasks)
        .leftJoin(repos, eq(repos.id, tasks.repo_id))
        .where(and(eq(tasks.user_id, userId), inArray(tasks.status, [...statuses])))
        .orderBy(
          QUEUED_STATUS_RANK_SQL,
          desc(tasks.priority),
          sql`${tasks.size} asc nulls last`,
          asc(tasks.enqueued_at),
        )

  res.json({ tasks: rows })
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

const redoSchema = z.object({
  feedback: z.string().trim().min(1, 'feedback is required').max(8000),
})

router.post('/tasks/:id/redo', requireAuth, async (req, res) => {
  const userId = req.user.id
  const taskId = Number(req.params.id)
  const parsed = redoSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  const feedback = parsed.data.feedback

  const [task] = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      prNumber: tasks.pr_number,
      branchName: tasks.branch_name,
      repoFullName: repos.full_name,
      issueNodeId: tasks.github_issue_node_id,
      projectNodeId: tasks.github_project_node_id,
    })
    .from(tasks)
    .leftJoin(repos, eq(repos.id, tasks.repo_id))
    .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

  if (!task) throw new AppError(404, 'task not found')
  if (task.status !== 'done') {
    throw new AppError(400, `task is not done (status: ${task.status})`)
  }
  if (!task.prNumber || !task.branchName || !task.repoFullName) {
    throw new AppError(400, 'task has no PR to revise')
  }

  const prState = await getPRState(task.repoFullName, task.prNumber)
  if (prState.merged) throw new AppError(400, 'PR is already merged — open a new task for further changes')
  if (prState.state === 'closed') throw new AppError(400, 'PR is closed — open a new task instead')

  await postPRComment(task.repoFullName, task.prNumber, feedback)

  if (task.projectNodeId) {
    try {
      const ctx = await getIssueProjectStatus(task.issueNodeId, task.projectNodeId)
      const option = ctx?.options.find((o) => o.name.toLowerCase() === 'in progress')
      if (ctx && option) {
        await setIssueProjectStatus(task.projectNodeId, ctx.projectItemId, ctx.statusFieldId, option.id)
      }
    } catch (err) {
      log.warn({ err, taskId }, 'redo: failed to set project status')
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'queued',
      revision_feedback: feedback,
      finished_at: null,
      started_at: null,
      failure_reason: null,
      enqueued_at: new Date(),
    })
    .where(eq(tasks.id, taskId))

  runWorkerTick(userId).catch(() => { /* logged inside worker */ })

  res.json({ ok: true, taskId, status: 'queued' })
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
