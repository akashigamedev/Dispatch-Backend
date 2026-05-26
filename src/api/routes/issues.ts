import { Router } from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, githubProjects, tasks } from '../../db/index.js'
import { fetchAssignedIssues, fetchIssueByNodeId, type DiscoveredIssue } from '../../github/projects.js'
import { getIssueProjectStatus, setIssueProjectStatus } from '../../github/issueStatus.js'
import { parseLabels } from '../../scheduler/labels.js'
import { AppError } from '../../util/errors.js'
import { log } from '../../log.js'

const router = Router()

interface IssueItem {
  issueNodeId: string
  issueNumber: number
  issueUrl: string
  title: string
  body: string | null
  repoFullName: string
  repoGithubId: number
  labels: string[]
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null
  priority: number
  projectNodeId: string
  projectTitle: string | null
  task: {
    id: number
    status: string
    branchName: string | null
    prUrl: string | null
    prNumber: number | null
    costUsd: string
    startedAt: string | null
    finishedAt: string | null
    failureReason: string | null
  } | null
}

async function getEnabledProjectMap(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ nodeId: githubProjects.project_node_id, title: githubProjects.title })
    .from(githubProjects)
    .where(and(eq(githubProjects.user_id, userId), eq(githubProjects.enabled, true)))
  return new Map(rows.map((r) => [r.nodeId, r.title]))
}

async function fetchTaskMap(userId: string, issueNodeIds: string[]): Promise<Map<string, IssueItem['task']>> {
  if (issueNodeIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: tasks.id,
      issueNodeId: tasks.github_issue_node_id,
      status: tasks.status,
      branchName: tasks.branch_name,
      prUrl: tasks.pr_url,
      prNumber: tasks.pr_number,
      costUsd: tasks.cost_usd,
      startedAt: tasks.started_at,
      finishedAt: tasks.finished_at,
      failureReason: tasks.failure_reason,
    })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), inArray(tasks.github_issue_node_id, issueNodeIds)))

  const map = new Map<string, IssueItem['task']>()
  for (const r of rows) {
    if (!r.issueNodeId) continue
    map.set(r.issueNodeId, {
      id: r.id,
      status: r.status,
      branchName: r.branchName,
      prUrl: r.prUrl,
      prNumber: r.prNumber,
      costUsd: r.costUsd,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      failureReason: r.failureReason,
    })
  }
  return map
}

function toItem(
  issue: DiscoveredIssue,
  projectNodeId: string,
  projectTitle: string | null,
  task: IssueItem['task'],
): IssueItem {
  const { size, priority } = parseLabels(issue.labels)
  return {
    issueNodeId: issue.nodeId,
    issueNumber: issue.number,
    issueUrl: issue.url,
    title: issue.title,
    body: issue.body,
    repoFullName: issue.repoFullName,
    repoGithubId: issue.repoGithubId,
    labels: issue.labels,
    size,
    priority,
    projectNodeId,
    projectTitle,
    task,
  }
}

router.get('/issues', requireAuth, async (req, res) => {
  const userId = req.user.id
  const projectFilter = req.query.project as string | undefined

  const enabledProjects = await getEnabledProjectMap(userId)
  if (enabledProjects.size === 0) {
    res.json({ items: [] })
    return
  }

  let issues: DiscoveredIssue[]
  try {
    issues = await fetchAssignedIssues()
  } catch (err) {
    log.error({ err, userId }, 'fetchAssignedIssues failed')
    throw new AppError(502, 'failed to fetch issues from GitHub')
  }

  const matched: Array<{ issue: DiscoveredIssue; projectNodeId: string }> = []
  for (const issue of issues) {
    const projectNodeId = issue.projectNodeIds.find((id) => enabledProjects.has(id))
    if (!projectNodeId) continue
    if (projectFilter && projectFilter !== projectNodeId) continue
    matched.push({ issue, projectNodeId })
  }

  const taskMap = await fetchTaskMap(userId, matched.map((m) => m.issue.nodeId))

  const items = matched.map(({ issue, projectNodeId }) =>
    toItem(issue, projectNodeId, enabledProjects.get(projectNodeId) ?? null, taskMap.get(issue.nodeId) ?? null),
  )

  res.json({ items })
})

router.get('/issues/:nodeId', requireAuth, async (req, res) => {
  const userId = req.user.id
  const nodeId = String(req.params.nodeId)

  const enabledProjects = await getEnabledProjectMap(userId)

  let issue: DiscoveredIssue | null
  try {
    issue = await fetchIssueByNodeId(nodeId)
  } catch (err) {
    log.error({ err, userId, nodeId }, 'fetchIssueByNodeId failed')
    throw new AppError(502, 'failed to fetch issue from GitHub')
  }
  if (!issue) throw new AppError(404, 'issue not found')

  const projectNodeId = issue.projectNodeIds.find((id) => enabledProjects.has(id))
  if (!projectNodeId) throw new AppError(404, 'issue not in any enabled project')

  const taskMap = await fetchTaskMap(userId, [issue.nodeId])
  const item = toItem(issue, projectNodeId, enabledProjects.get(projectNodeId) ?? null, taskMap.get(issue.nodeId) ?? null)

  res.json(item)
})

router.get('/issues/:nodeId/status-options', requireAuth, async (req, res) => {
  const userId = req.user.id
  const issueNodeId = String(req.params.nodeId)
  const projectNodeId = String(req.query.project ?? '')
  if (!projectNodeId) throw new AppError(400, 'missing project query parameter')

  const enabledProjects = await getEnabledProjectMap(userId)
  if (!enabledProjects.has(projectNodeId)) {
    throw new AppError(404, 'project not enabled for this user')
  }

  const ctx = await getIssueProjectStatus(issueNodeId, projectNodeId)
  if (!ctx) throw new AppError(404, 'issue is not on this project or project has no Status field')

  res.json({
    current: ctx.currentStatus,
    options: ctx.options.map((o) => o.name),
  })
})

router.put('/issues/:nodeId/status', requireAuth, async (req, res) => {
  const userId = req.user.id
  const issueNodeId = String(req.params.nodeId)
  const projectNodeId = String(req.body?.projectNodeId ?? '')
  const status = String(req.body?.status ?? '')
  if (!projectNodeId || !status) {
    throw new AppError(400, 'projectNodeId and status are required')
  }

  const enabledProjects = await getEnabledProjectMap(userId)
  if (!enabledProjects.has(projectNodeId)) {
    throw new AppError(404, 'project not enabled for this user')
  }

  const ctx = await getIssueProjectStatus(issueNodeId, projectNodeId)
  if (!ctx) throw new AppError(404, 'issue is not on this project or project has no Status field')

  const option = ctx.options.find(
    (o) => o.name.toLowerCase() === status.toLowerCase(),
  )
  if (!option) throw new AppError(400, `unknown status "${status}" for this project`)

  try {
    await setIssueProjectStatus(projectNodeId, ctx.projectItemId, ctx.statusFieldId, option.id)
  } catch (err) {
    log.error({ err, userId, issueNodeId, status }, 'setIssueProjectStatus failed')
    throw new AppError(502, 'failed to update issue status on GitHub')
  }

  res.json({ ok: true, status: option.name })
})

export default router
