export const DONE_STATUSES = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled', 'wontfix'])

export interface ProjectItemNode {
  fieldValueByName?: { name?: string } | null
}

export interface IssueProjectItems {
  projectItems: { nodes: Array<ProjectItemNode> }
}

export function isDoneInAnyProject(node: IssueProjectItems): boolean {
  for (const item of node.projectItems.nodes) {
    const status = item.fieldValueByName?.name?.toLowerCase().trim()
    if (status && DONE_STATUSES.has(status)) return true
  }
  return false
}
