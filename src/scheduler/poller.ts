import { and, eq } from 'drizzle-orm'
import { db, profiles, githubProjects, repos, tasks } from '../db/index.js'
import { fetchAssignedProjectItems, type DiscoveredIssue } from '../github/projects.js'
import { log } from '../log.js'

function parseLabels(labels: string[]): {
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | null
  priority: number
} {
  const sizeLabel = labels.find((l) => /^size\/(XS|S|M|L|XL)$/.test(l))
  const size = sizeLabel
    ? (sizeLabel.split('/')[1] as 'XS' | 'S' | 'M' | 'L' | 'XL')
    : null
  const priorityLabel = labels.find((l) => /^priority\/[0-3]$/.test(l))
  const priority = priorityLabel ? parseInt(priorityLabel.split('/')[1]) : 0
  return { size, priority }
}

async function findOrCreateRepo(
  userId: string,
  issue: DiscoveredIssue,
): Promise<number | null> {
  const [owner, name] = issue.repoFullName.split('/')
  if (!owner || !name) return null

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

async function upsertTask(userId: string, repoId: number, issue: DiscoveredIssue) {
  const { size, priority } = parseLabels(issue.labels)
  await db
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
}

export async function pollProjects(): Promise<void> {
  const users = await db.select().from(profiles)

  for (const user of users) {
    const projects = await db
      .select()
      .from(githubProjects)
      .where(and(eq(githubProjects.user_id, user.id), eq(githubProjects.enabled, true)))

    if (projects.length === 0) continue

    log.debug({ userId: user.id, login: user.github_login }, 'polling projects')

    for (const project of projects) {
      try {
        const issues = await fetchAssignedProjectItems(
          project.project_node_id,
          user.github_login,
        )
        for (const issue of issues) {
          const repoId = await findOrCreateRepo(user.id, issue)
          if (!repoId) continue
          await upsertTask(user.id, repoId, issue)
        }
        log.info(
          { projectId: project.project_node_id, found: issues.length },
          'poll complete',
        )
      } catch (err) {
        log.error({ err, projectId: project.project_node_id }, 'poll failed')
      }
    }
  }
}
