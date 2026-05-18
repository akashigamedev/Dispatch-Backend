import { getGraphql } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'
import { isQueueable } from './projectStatus.js'
export { isQueueable } from './projectStatus.js'

interface ProjectStatusValue {
  name?: string
}

interface ProjectItemNode {
  project?: { id: string } | null
  fieldValueByName?: ProjectStatusValue | null
}

interface IssueSearchNode {
  id: string
  number: number
  title: string
  body: string | null
  url: string
  repository: { nameWithOwner: string; databaseId: number }
  labels: { nodes: Array<{ name: string }> }
  projectItems: { nodes: Array<ProjectItemNode> }
}

interface IssueSearchResponse {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: Array<Partial<IssueSearchNode>>
  }
}

const QUERY = `
  query GetAssignedIssues($cursor: String) {
    search(query: "is:issue is:open assignee:@me", type: ISSUE, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          id number title body url
          repository { nameWithOwner databaseId }
          labels(first: 20) { nodes { name } }
          projectItems(first: 10) {
            nodes {
              project { id }
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }
      }
    }
  }
`

export interface DiscoveredIssue {
  nodeId: string
  number: number
  title: string
  body: string | null
  url: string
  repoFullName: string
  repoGithubId: number
  labels: string[]
  projectNodeIds: string[]
}


function isIssue(node: Partial<IssueSearchNode>): node is IssueSearchNode {
  return typeof node.number === 'number' && typeof node.id === 'string'
}

export async function fetchAssignedIssues(
  opts: { includeAllStatuses?: boolean } = {},
): Promise<DiscoveredIssue[]> {
  const graphql = getGraphql()
  const discovered: DiscoveredIssue[] = []
  let cursor: string | null = null

  do {
    const data: IssueSearchResponse = await withGithubRetry(() =>
      graphql<IssueSearchResponse>(QUERY, { cursor: cursor ?? undefined }),
    )

    for (const node of data.search.nodes) {
      if (!isIssue(node)) continue
      if (!opts.includeAllStatuses && !isQueueable(node)) continue
      discovered.push({
        nodeId: node.id,
        number: node.number,
        title: node.title,
        body: node.body ?? null,
        url: node.url,
        repoFullName: node.repository.nameWithOwner,
        repoGithubId: node.repository.databaseId,
        labels: node.labels.nodes.map((l: { name: string }) => l.name),
        projectNodeIds: node.projectItems.nodes
          .map((it) => it.project?.id)
          .filter((id): id is string => typeof id === 'string'),
      })
    }

    cursor = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
  } while (cursor)

  return discovered
}
