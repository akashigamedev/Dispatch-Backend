import { describe, it, expect } from 'vitest'
import { parseLabels } from '../src/scheduler/labels.js'
import { isQueueable } from '../src/github/projectStatus.js'

describe('parseLabels', () => {
  it('returns null size and 0 priority when no relevant labels', () => {
    expect(parseLabels(['bug', 'help wanted'])).toEqual({ size: null, priority: 0 })
  })

  it('parses size labels', () => {
    for (const s of ['XS', 'S', 'M', 'L', 'XL'] as const) {
      expect(parseLabels([`size/${s}`]).size).toBe(s)
    }
  })

  it('parses priority labels 0–3', () => {
    for (const p of [0, 1, 2, 3]) {
      expect(parseLabels([`priority/${p}`]).priority).toBe(p)
    }
  })

  it('handles both size and priority in the same label list', () => {
    expect(parseLabels(['size/M', 'priority/2', 'bug'])).toEqual({ size: 'M', priority: 2 })
  })

  it('ignores malformed size labels', () => {
    expect(parseLabels(['size/XXL', 'size/', 'SIZE/M'])).toEqual({ size: null, priority: 0 })
  })

  it('ignores priority values outside 0–3', () => {
    expect(parseLabels(['priority/4', 'priority/-1'])).toEqual({ size: null, priority: 0 })
  })

  it('uses first matching size label when multiple present', () => {
    const result = parseLabels(['size/S', 'size/L'])
    expect(['S', 'L']).toContain(result.size)
  })
})

// Minimal shape matching the IssueSearchNode projectItems field
function makeNode(statuses: (string | undefined)[]) {
  return {
    projectItems: {
      nodes: statuses.map((name) => ({
        fieldValueByName: name !== undefined ? { name } : null,
      })),
    },
  }
}

describe('isQueueable', () => {
  it('returns false when no project items', () => {
    expect(isQueueable(makeNode([]) as never)).toBe(false)
  })

  it('returns true for queueable statuses (case- and space-insensitive)', () => {
    const queueable = ['Backlog', 'backlog', 'BACKLOG', 'Todo', 'todo', 'To Do', 'TO DO', 'to  do']
    for (const status of queueable) {
      expect(isQueueable(makeNode([status]) as never), status).toBe(true)
    }
  })

  it('returns false for non-queueable statuses', () => {
    const nonQueueable = ['In Progress', 'Code Review', 'Internal Review', 'QA Testing', 'Done', 'Completed', 'Cancelled']
    for (const status of nonQueueable) {
      expect(isQueueable(makeNode([status]) as never), status).toBe(false)
    }
  })

  it('returns true if any project item is queueable even if others are not', () => {
    expect(isQueueable(makeNode(['In Progress', 'Backlog']) as never)).toBe(true)
  })

  it('returns false when fieldValueByName is null', () => {
    expect(isQueueable(makeNode([undefined]) as never)).toBe(false)
  })
})
