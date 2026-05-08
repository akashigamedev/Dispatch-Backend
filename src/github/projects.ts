import { getGraphql } from './client.js'

interface ProjectStatusValue {
  name?: string
}

interface ProjectItemNode {
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
}

// Terminal Project status values that mean "do not work on this".
const DONE_STATUSES = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled', 'wontfix'])

function isDoneInAnyProject(node: IssueSearchNode): boolean {
  for (const item of node.projectItems.nodes) {
    const status = item.fieldValueByName?.name?.toLowerCase().trim()
    if (status && DONE_STATUSES.has(status)) return true
  }
  return false
}

function isIssue(node: Partial<IssueSearchNode>): node is IssueSearchNode {
  return typeof node.number === 'number' && typeof node.id === 'string'
}

export async function fetchAssignedIssues(): Promise<DiscoveredIssue[]> {
  const graphql = getGraphql()
  const discovered: DiscoveredIssue[] = []
  let cursor: string | null = null

  do {
    const data: IssueSearchResponse = await graphql<IssueSearchResponse>(QUERY, {
      cursor: cursor ?? undefined,
    })

    for (const node of data.search.nodes) {
      if (!isIssue(node)) continue
      if (isDoneInAnyProject(node)) continue
      discovered.push({
        nodeId: node.id,
        number: node.number,
        title: node.title,
        body: node.body ?? null,
        url: node.url,
        repoFullName: node.repository.nameWithOwner,
        repoGithubId: node.repository.databaseId,
        labels: node.labels.nodes.map((l: { name: string }) => l.name),
      })
    }

    cursor = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
  } while (cursor)

  return discovered
}
