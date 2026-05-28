export const QUEUEABLE_STATUSES = new Set(['backlog', 'todo', 'inprogress'])

export interface ProjectItemNode {
  fieldValueByName?: { name?: string } | null
}

export interface IssueProjectItems {
  projectItems: { nodes: Array<ProjectItemNode> }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').trim()
}

export function isQueueable(node: IssueProjectItems): boolean {
  for (const item of node.projectItems.nodes) {
    const raw = item.fieldValueByName?.name
    if (!raw) continue
    if (QUEUEABLE_STATUSES.has(normalize(raw))) return true
  }
  return false
}
