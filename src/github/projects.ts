import { getGraphql } from './client.js'

interface IssueContent {
  id: string
  number: number
  title: string
  body: string | null
  url: string
  repository: { nameWithOwner: string; databaseId: number }
  assignees: { nodes: Array<{ login: string }> }
  labels: { nodes: Array<{ name: string }> }
}

interface FieldValue {
  name?: string
  field?: { name?: string }
}

interface ProjectItemNode {
  content: Partial<IssueContent> | null
  fieldValues: { nodes: FieldValue[] }
}

interface ProjectItemsPage {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: ProjectItemNode[]
    }
  } | null
}

const QUERY = `
  query GetProjectItems($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content {
              ... on Issue {
                id number title body url
                repository { nameWithOwner databaseId }
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }
              }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
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

function isStatusDone(fieldValues: FieldValue[]): boolean {
  return fieldValues.some(
    (fv) =>
      fv.field?.name?.toLowerCase() === 'status' &&
      fv.name?.toLowerCase() === 'done',
  )
}

function isIssue(content: Partial<IssueContent> | null): content is IssueContent {
  return content != null && typeof content.number === 'number'
}

export async function fetchAssignedProjectItems(
  projectNodeId: string,
  userLogin: string,
): Promise<DiscoveredIssue[]> {
  const graphql = getGraphql()
  const discovered: DiscoveredIssue[] = []
  let cursor: string | null = null

  do {
    const data: ProjectItemsPage = await graphql<ProjectItemsPage>(QUERY, {
      projectId: projectNodeId,
      cursor: cursor ?? undefined,
    })

    type ItemsType = NonNullable<ProjectItemsPage['node']>['items']
    const items: ItemsType | undefined = data.node?.items
    if (!items) break

    for (const item of items.nodes) {
      if (!isIssue(item.content)) continue
      if (isStatusDone(item.fieldValues.nodes)) continue
      const assignees = item.content.assignees.nodes.map((a: { login: string }) => a.login)
      if (!assignees.includes(userLogin)) continue

      discovered.push({
        nodeId: item.content.id,
        number: item.content.number,
        title: item.content.title,
        body: item.content.body ?? null,
        url: item.content.url,
        repoFullName: item.content.repository.nameWithOwner,
        repoGithubId: item.content.repository.databaseId,
        labels: item.content.labels.nodes.map((l: { name: string }) => l.name),
      })
    }

    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null
  } while (cursor)

  return discovered
}
