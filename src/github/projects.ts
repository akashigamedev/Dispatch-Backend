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

interface IssueNode {
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
    nodes: Array<Partial<IssueNode>>
  }
}

interface IssueByIdResponse {
  node: (Partial<IssueNode> & { __typename?: string }) | null
}

const ISSUE_FIELDS = `
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
`

const SEARCH_QUERY = `
  query GetAssignedIssues($cursor: String) {
    search(query: "is:issue is:open assignee:@me", type: ISSUE, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          ${ISSUE_FIELDS}
        }
      }
    }
  }
`

const NODE_QUERY = `
  query GetIssueByNodeId($id: ID!) {
    node(id: $id) {
      __typename
      ... on Issue {
        ${ISSUE_FIELDS}
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


function isIssue(node: Partial<IssueNode>): node is IssueNode {
  return typeof node.number === 'number' && typeof node.id === 'string'
}

function toDiscovered(node: IssueNode): DiscoveredIssue {
  return {
    nodeId: node.id,
    number: node.number,
    title: node.title,
    body: node.body ?? null,
    url: node.url,
    repoFullName: node.repository.nameWithOwner,
    repoGithubId: node.repository.databaseId,
    labels: node.labels.nodes.map((l) => l.name),
    projectNodeIds: node.projectItems.nodes
      .map((it) => it.project?.id)
      .filter((id): id is string => typeof id === 'string'),
  }
}

export async function fetchAssignedIssues(
  opts: { includeAllStatuses?: boolean } = {},
): Promise<DiscoveredIssue[]> {
  const graphql = getGraphql()
  const discovered: DiscoveredIssue[] = []
  let cursor: string | null = null

  do {
    const data: IssueSearchResponse = await withGithubRetry(() =>
      graphql<IssueSearchResponse>(SEARCH_QUERY, { cursor: cursor ?? undefined }),
    )

    for (const node of data.search.nodes) {
      if (!isIssue(node)) continue
      if (!opts.includeAllStatuses && !isQueueable(node)) continue
      discovered.push(toDiscovered(node))
    }

    cursor = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
  } while (cursor)

  return discovered
}

export async function fetchIssueByNodeId(nodeId: string): Promise<DiscoveredIssue | null> {
  const graphql = getGraphql()
  const data: IssueByIdResponse = await withGithubRetry(() =>
    graphql<IssueByIdResponse>(NODE_QUERY, { id: nodeId }),
  )
  const node = data.node
  if (!node || node.__typename !== 'Issue' || !isIssue(node)) return null
  return toDiscovered(node)
}
