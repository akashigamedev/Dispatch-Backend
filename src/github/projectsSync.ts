import { eq } from 'drizzle-orm'
import { getGraphql } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'
import { db, githubProjects } from '../db/index.js'
import { log } from '../log.js'

interface ProjectNode {
  id: string
  number: number
  title: string
  owner: { login?: string } | null
}

interface ViewerProjectsResponse {
  viewer: {
    projectsV2: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: ProjectNode[]
    }
    organizations: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<{
        login: string
        projectsV2: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: ProjectNode[]
        }
      }>
    }
  }
}

const QUERY = `
  query SyncProjects($viewerCursor: String, $orgCursor: String) {
    viewer {
      projectsV2(first: 50, after: $viewerCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id number title owner { ... on User { login } ... on Organization { login } } }
      }
      organizations(first: 25, after: $orgCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          login
          projectsV2(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { id number title owner { ... on User { login } ... on Organization { login } } }
          }
        }
      }
    }
  }
`

interface DiscoveredProject {
  nodeId: string
  number: number
  title: string
  ownerLogin: string
}

async function fetchAllProjects(): Promise<DiscoveredProject[]> {
  const graphql = getGraphql()
  const seen = new Map<string, DiscoveredProject>()
  let viewerCursor: string | null = null
  let orgCursor: string | null = null

  do {
    const data: ViewerProjectsResponse = await withGithubRetry(() =>
      graphql<ViewerProjectsResponse>(QUERY, {
        viewerCursor: viewerCursor ?? undefined,
        orgCursor: orgCursor ?? undefined,
      }),
    )

    for (const p of data.viewer.projectsV2.nodes) {
      if (!seen.has(p.id)) {
        seen.set(p.id, {
          nodeId: p.id,
          number: p.number,
          title: p.title,
          ownerLogin: p.owner?.login ?? '',
        })
      }
    }

    for (const org of data.viewer.organizations.nodes) {
      for (const p of org.projectsV2.nodes) {
        if (!seen.has(p.id)) {
          seen.set(p.id, {
            nodeId: p.id,
            number: p.number,
            title: p.title,
            ownerLogin: p.owner?.login ?? org.login,
          })
        }
      }
    }

    viewerCursor = data.viewer.projectsV2.pageInfo.hasNextPage
      ? data.viewer.projectsV2.pageInfo.endCursor
      : null
    orgCursor = data.viewer.organizations.pageInfo.hasNextPage
      ? data.viewer.organizations.pageInfo.endCursor
      : null
  } while (viewerCursor || orgCursor)

  return Array.from(seen.values())
}

export async function syncProjectsForUser(userId: string): Promise<{ discovered: number; inserted: number }> {
  const discovered = await fetchAllProjects()

  const existing = await db
    .select({ nodeId: githubProjects.project_node_id })
    .from(githubProjects)
    .where(eq(githubProjects.user_id, userId))
  const existingIds = new Set(existing.map((r) => r.nodeId))

  let inserted = 0
  for (const p of discovered) {
    if (existingIds.has(p.nodeId)) continue
    await db.insert(githubProjects).values({
      user_id: userId,
      project_node_id: p.nodeId,
      project_number: p.number,
      owner_login: p.ownerLogin,
      title: p.title,
      enabled: false,
    }).onConflictDoNothing()
    inserted++
  }

  log.info({ userId, discovered: discovered.length, inserted }, 'projects sync complete')
  return { discovered: discovered.length, inserted }
}
