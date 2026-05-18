import { getGraphql } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'

export interface ProjectStatusContext {
  projectItemId: string
  statusFieldId: string
  currentStatus: string | null
  options: Array<{ id: string; name: string }>
}

interface StatusContextResponse {
  issue: {
    projectItems: {
      nodes: Array<{
        id: string
        project: { id: string }
        fieldValueByName: { name?: string } | null
      }>
    }
  } | null
  project: {
    field: {
      id: string
      options: Array<{ id: string; name: string }>
    } | null
  } | null
}

const STATUS_CONTEXT_QUERY = `
  query IssueStatusContext($issueId: ID!, $projectId: ID!) {
    issue: node(id: $issueId) {
      ... on Issue {
        projectItems(first: 20) {
          nodes {
            id
            project { id }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
    project: node(id: $projectId) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField {
            id
            options { id name }
          }
        }
      }
    }
  }
`

export async function getIssueProjectStatus(
  issueNodeId: string,
  projectNodeId: string,
): Promise<ProjectStatusContext | null> {
  const graphql = getGraphql()
  const data: StatusContextResponse = await withGithubRetry(() =>
    graphql<StatusContextResponse>(STATUS_CONTEXT_QUERY, {
      issueId: issueNodeId,
      projectId: projectNodeId,
    }),
  )

  const item = data.issue?.projectItems.nodes.find((n) => n.project.id === projectNodeId)
  const field = data.project?.field
  if (!item || !field) return null

  return {
    projectItemId: item.id,
    statusFieldId: field.id,
    currentStatus: item.fieldValueByName?.name ?? null,
    options: field.options.map((o) => ({ id: o.id, name: o.name })),
  }
}

export async function setIssueProjectStatus(
  projectNodeId: string,
  projectItemId: string,
  statusFieldId: string,
  optionId: string,
): Promise<void> {
  const graphql = getGraphql()
  await withGithubRetry(() =>
    graphql(
      `mutation SetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }`,
      { projectId: projectNodeId, itemId: projectItemId, fieldId: statusFieldId, optionId },
    ),
  )
}
