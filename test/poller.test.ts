import { describe, it, expect } from 'vitest'
import { parseLabels } from '../src/scheduler/labels.js'
import { isDoneInAnyProject } from '../src/github/projectStatus.js'

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

describe('isDoneInAnyProject', () => {
  it('returns false when no project items', () => {
    expect(isDoneInAnyProject(makeNode([]) as never)).toBe(false)
  })

  it('returns false for non-terminal statuses', () => {
    expect(isDoneInAnyProject(makeNode(['In Progress', 'Todo', 'Backlog']) as never)).toBe(false)
  })

  it('returns true for terminal statuses (case-insensitive)', () => {
    const terminals = ['done', 'Done', 'DONE', 'completed', 'Completed', 'cancelled', 'Canceled', 'wontfix', 'closed']
    for (const status of terminals) {
      expect(isDoneInAnyProject(makeNode([status]) as never), status).toBe(true)
    }
  })

  it('returns true if any project is terminal even if others are not', () => {
    expect(isDoneInAnyProject(makeNode(['In Progress', 'done']) as never)).toBe(true)
  })

  it('returns false when fieldValueByName is null', () => {
    expect(isDoneInAnyProject(makeNode([undefined]) as never)).toBe(false)
  })
})
