import { getGraphql, getOctokit } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'

export interface WritableRepo {
  fullName: string
  githubId: number
  defaultBranch: string
}

interface UserReposResponseItem {
  name: string
  full_name: string
  id: number
  default_branch: string
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean }
  archived?: boolean
  disabled?: boolean
}

export async function listWritableRepos(): Promise<WritableRepo[]> {
  const out: WritableRepo[] = []
  let page = 1
  for (;;) {
    const { repos, hasMore } = await listWritableReposPage(page, 100)
    out.push(...repos)
    if (!hasMore) break
    page += 1
    if (page > 10) break // safety cap (1000 repos)
  }
  return out
}

export async function listWritableReposPage(
  page: number,
  perPage: number,
): Promise<{ repos: WritableRepo[]; hasMore: boolean }> {
  const octokit = getOctokit()
  const resp = await withGithubRetry(() =>
    octokit.request('GET /user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      per_page: perPage,
      page,
      sort: 'updated',
    }),
  )
  const data = resp.data as UserReposResponseItem[]
  const repos: WritableRepo[] = []
  for (const r of data) {
    if (r.archived || r.disabled) continue
    if (!r.permissions?.push && !r.permissions?.admin && !r.permissions?.maintain) continue
    repos.push({ fullName: r.full_name, githubId: r.id, defaultBranch: r.default_branch })
  }
  return { repos, hasMore: data.length === perPage }
}

interface ViewerResponse {
  viewer: { id: string; login: string }
}

let viewerCache: { id: string; login: string } | null = null

export async function getViewer(): Promise<{ nodeId: string; login: string }> {
  if (viewerCache) return { nodeId: viewerCache.id, login: viewerCache.login }
  const graphql = getGraphql()
  const data: ViewerResponse = await withGithubRetry(() =>
    graphql<ViewerResponse>(`query { viewer { id login } }`),
  )
  viewerCache = data.viewer
  return { nodeId: data.viewer.id, login: data.viewer.login }
}

export type FieldKind = 'single_select' | 'date' | 'text' | 'number' | 'iteration'

export interface ProjectFieldOption {
  id: string
  name: string
}

export interface ProjectIteration {
  id: string
  title: string
  startDate: string
  duration: number
}

export interface ProjectField {
  id: string
  name: string
  kind: FieldKind
  options?: ProjectFieldOption[]
  iterations?: ProjectIteration[]
}

interface ProjectFieldsResponse {
  node: {
    fields: {
      nodes: Array<
        | {
            __typename: 'ProjectV2SingleSelectField'
            id: string
            name: string
            options: Array<{ id: string; name: string }>
          }
        | {
            __typename: 'ProjectV2IterationField'
            id: string
            name: string
            configuration: {
              iterations: Array<{ id: string; title: string; startDate: string; duration: number }>
              completedIterations: Array<{
                id: string
                title: string
                startDate: string
                duration: number
              }>
            }
          }
        | { __typename: 'ProjectV2Field'; id: string; name: string; dataType: string }
        | { __typename: string }
      >
    }
  } | null
}

const PROJECT_FIELDS_QUERY = `
  query GetProjectFields($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
            ... on ProjectV2IterationField {
              id
              name
              configuration {
                iterations { id title startDate duration }
                completedIterations { id title startDate duration }
              }
            }
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
`

// Built-in fields we always skip — they map to the issue itself or to assignees/labels/etc.
// rather than to project-item custom values, so showing them in a generic form makes no sense.
const SKIPPED_FIELD_NAMES = new Set([
  'title',
  'assignees',
  'labels',
  'linked pull requests',
  'milestone',
  'repository',
  'reviewers',
  'parent issue',
  'sub-issues progress',
])

export async function getProjectFields(projectNodeId: string): Promise<ProjectField[]> {
  const graphql = getGraphql()
  const data: ProjectFieldsResponse = await withGithubRetry(() =>
    graphql<ProjectFieldsResponse>(PROJECT_FIELDS_QUERY, { id: projectNodeId }),
  )

  const out: ProjectField[] = []
  const nodes = data.node?.fields?.nodes ?? []
  for (const node of nodes) {
    if (!('name' in node)) continue
    const n = node as { name: string }
    const nameLower = n.name.toLowerCase().trim()
    if (SKIPPED_FIELD_NAMES.has(nameLower)) continue

    if (node.__typename === 'ProjectV2SingleSelectField') {
      const ss = node as { id: string; name: string; options: Array<{ id: string; name: string }> }
      out.push({
        id: ss.id,
        name: ss.name,
        kind: 'single_select',
        options: ss.options.map((o) => ({ id: o.id, name: o.name })),
      })
    } else if (node.__typename === 'ProjectV2IterationField') {
      const it = node as {
        id: string
        name: string
        configuration: {
          iterations: Array<{ id: string; title: string; startDate: string; duration: number }>
        }
      }
      out.push({
        id: it.id,
        name: it.name,
        kind: 'iteration',
        iterations: it.configuration.iterations.map((i) => ({
          id: i.id,
          title: i.title,
          startDate: i.startDate,
          duration: i.duration,
        })),
      })
    } else if (node.__typename === 'ProjectV2Field') {
      const f = node as { id: string; name: string; dataType: string }
      const kind: FieldKind | null =
        f.dataType === 'DATE'
          ? 'date'
          : f.dataType === 'TEXT'
            ? 'text'
            : f.dataType === 'NUMBER'
              ? 'number'
              : null
      if (kind) out.push({ id: f.id, name: f.name, kind })
    }
  }

  return out
}

export interface FieldValueInput {
  fieldId: string
  singleSelectOptionId?: string
  date?: string
  text?: string
  number?: number
  iterationId?: string
}

export interface CreateIssueInput {
  repoFullName: string
  title: string
  body: string | null
  projectNodeId: string
  fieldValues: FieldValueInput[]
}

export interface CreateIssueResult {
  issueNodeId: string
  issueNumber: number
  issueUrl: string
  repoGithubId: number
  projectItemId: string
}

interface RepoGetResponse {
  data: { id: number; node_id: string }
}

interface CreateIssueMutationResponse {
  createIssue: { issue: { id: string; number: number; url: string } }
}

interface AddProjectItemResponse {
  addProjectV2ItemById: { item: { id: string } }
}

function buildFieldValue(v: FieldValueInput): Record<string, string | number> {
  if (v.singleSelectOptionId !== undefined) return { singleSelectOptionId: v.singleSelectOptionId }
  if (v.date !== undefined) return { date: v.date }
  if (v.text !== undefined) return { text: v.text }
  if (v.number !== undefined) return { number: v.number }
  if (v.iterationId !== undefined) return { iterationId: v.iterationId }
  throw new Error(`fieldValues[${v.fieldId}]: no value set`)
}

export async function createIssueAndAddToProject(
  input: CreateIssueInput,
): Promise<CreateIssueResult> {
  const octokit = getOctokit()
  const graphql = getGraphql()

  const [owner, name] = input.repoFullName.split('/')
  if (!owner || !name) throw new Error(`invalid repo name: ${input.repoFullName}`)

  const repoResp = (await withGithubRetry(() =>
    octokit.request('GET /repos/{owner}/{repo}', { owner, repo: name }),
  )) as RepoGetResponse
  const repoNodeId = repoResp.data.node_id
  const repoGithubId = repoResp.data.id

  const viewer = await getViewer()

  const created: CreateIssueMutationResponse = await withGithubRetry(() =>
    graphql<CreateIssueMutationResponse>(
      `mutation CreateIssue($repositoryId: ID!, $title: String!, $body: String, $assigneeIds: [ID!]) {
        createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, assigneeIds: $assigneeIds }) {
          issue { id number url }
        }
      }`,
      {
        repositoryId: repoNodeId,
        title: input.title,
        body: input.body ?? null,
        assigneeIds: [viewer.nodeId],
      },
    ),
  )
  const issue = created.createIssue.issue

  const added: AddProjectItemResponse = await withGithubRetry(() =>
    graphql<AddProjectItemResponse>(
      `mutation AddItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`,
      { projectId: input.projectNodeId, contentId: issue.id },
    ),
  )
  const projectItemId = added.addProjectV2ItemById.item.id

  for (const fv of input.fieldValues) {
    const valueShape = buildFieldValue(fv)
    await withGithubRetry(() =>
      graphql(
        `mutation SetField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
            projectV2Item { id }
          }
        }`,
        {
          projectId: input.projectNodeId,
          itemId: projectItemId,
          fieldId: fv.fieldId,
          value: valueShape,
        },
      ),
    )
  }

  return {
    issueNodeId: issue.id,
    issueNumber: issue.number,
    issueUrl: issue.url,
    repoGithubId,
    projectItemId,
  }
}
