import { and, eq } from 'drizzle-orm'
import { db, repos, tasks } from '../db/index.js'
import { fetchAssignedIssues, type DiscoveredIssue } from '../github/projects.js'
import { log } from '../log.js'

function parseLabels(labels: string[]): {
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null
  priority: number
} {
  const sizeLabel = labels.find((l) => /^size\/(XS|S|M|L|XL)$/.test(l))
  const size = sizeLabel ? (sizeLabel.split('/')[1] as 'XS' | 'S' | 'M' | 'L' | 'XL') : null
  const priorityLabel = labels.find((l) => /^priority\/[0-3]$/.test(l))
  const priority = priorityLabel ? parseInt(priorityLabel.split('/')[1]) : 0
  return { size, priority }
}

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
  log.info({ found: issues.length, newlyQueued: queued }, 'poll complete')
}
