import { and, eq, isNull, lt } from 'drizzle-orm'
import { db, profiles, repos, tasks } from '../db/index.js'
import { fetchAssignedIssues, type DiscoveredIssue } from '../github/projects.js'
import { sizeTask } from '../claude/sizer.js'
import { addSpend } from './budget.js'
import { parseLabels } from './labels.js'
import { detectModelLimit } from '../util/claudeError.js'
import { log } from '../log.js'

export { parseLabels } from './labels.js'

async function findOrCreateRepo(userId: string, issue: DiscoveredIssue): Promise<number | null> {
  const existing = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.user_id, userId), eq(repos.full_name, issue.repoFullName)))
    .limit(1)

  if (existing[0]) return existing[0].id

  const inserted = await db
    .insert(repos)
    .values({
      user_id: userId,
      full_name: issue.repoFullName,
      github_repo_id: issue.repoGithubId,
    })
    .returning({ id: repos.id })

  return inserted[0]?.id ?? null
}

export async function pollProjects(userId: string): Promise<void> {
  log.debug({ userId }, 'polling assigned issues')
  const issues = await fetchAssignedIssues()
  let queued = 0
  for (const issue of issues) {
    const repoId = await findOrCreateRepo(userId, issue)
    if (!repoId) continue
    const { size, priority } = parseLabels(issue.labels)
    const result = await db
      .insert(tasks)
      .values({
        user_id: userId,
        repo_id: repoId,
        github_issue_node_id: issue.nodeId,
        github_issue_number: issue.number,
        github_issue_url: issue.url,
        title: issue.title,
        body: issue.body,
        size,
        priority,
        status: 'queued',
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id })
    if (result.length > 0) queued++
  }
  if (queued > 0) {
    log.info({ found: issues.length, newlyQueued: queued }, 'poll complete — new tasks queued')
  } else {
    log.debug({ found: issues.length }, 'poll complete — no new tasks')
  }
}

export async function requeueStaleAwaitingInput(userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const requeued = await db
    .update(tasks)
    .set({ status: 'queued', finished_at: null })
    .where(and(
      eq(tasks.user_id, userId),
      eq(tasks.status, 'awaiting_input'),
      lt(tasks.finished_at, cutoff),
    ))
    .returning({ id: tasks.id })
  if (requeued.length > 0) {
    log.info({ count: requeued.length }, 'requeued stale awaiting_input tasks')
  }
}

export async function sizeUnsizedTasks(userId: string): Promise<void> {
  const [profile] = await db
    .select({ models: profiles.models })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  // any: models jsonb is typed as unknown from Drizzle; cast is safe given schema contract
  const sizerModelId: string =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (profile?.models as any)?.sizer?.id ?? 'claude-opus-4-7'

  const unsized = await db
    .select({ id: tasks.id, title: tasks.title, body: tasks.body })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.status, 'queued'), isNull(tasks.size)))
    .limit(10)

  if (unsized.length === 0) return

  log.info({ count: unsized.length }, 'sizing unsized tasks')

  for (const task of unsized) {
    try {
      const { size, usage } = await sizeTask(task.title, task.body, sizerModelId)

      await db
        .update(tasks)
        .set({
          size,
          cost_usd: usage.costUsd.toFixed(4),
          tokens_in: usage.inputTokens,
          tokens_out: usage.outputTokens,
        })
        .where(eq(tasks.id, task.id))

      await addSpend(userId, usage.costUsd)

      log.info({ taskId: task.id, size, costUsd: usage.costUsd }, 'task sized')
    } catch (err) {
      const limitInfo = detectModelLimit(err)
      if (limitInfo) {
        await db.update(profiles)
          .set({ active: false, anthropic_resume_after: limitInfo.resumeAfter })
          .where(eq(profiles.id, userId))
        log.warn({ userId, kind: limitInfo.kind, resumeAfter: limitInfo.resumeAfter }, 'Claude limit during sizing — auto checkout')
        return
      }
      log.error({ err, taskId: task.id }, 'sizer error — skipping task')
    }
  }
}
