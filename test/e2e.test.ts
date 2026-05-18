/**
 * End-to-end smoke test against a real sandbox GitHub repo.
 *
 * Prerequisites:
 *   GITHUB_PAT  — classic PAT with repo + read:org + project scopes
 *   E2E_SANDBOX_REPO — "owner/repo" of a repo you own with ≥1 open issue assigned to you
 *
 * Run with:
 *   GITHUB_PAT=ghp_... E2E_SANDBOX_REPO=owner/repo npx vitest run test/e2e.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'

const hasEnv = !!(process.env.GITHUB_PAT && process.env.E2E_SANDBOX_REPO)

describe.skipIf(!hasEnv)('e2e: GitHub connectivity', () => {
  let sandboxRepo: string

  beforeAll(() => {
    process.env.GITHUB_PAT = process.env.GITHUB_PAT!
    sandboxRepo = process.env.E2E_SANDBOX_REPO!
  })

  it('fetchAssignedIssues returns at least one issue from the sandbox repo', async () => {
    const { fetchAssignedIssues } = await import('../src/github/projects.js')
    const issues = await fetchAssignedIssues()
    const inRepo = issues.filter((i) => i.repoFullName === sandboxRepo)
    expect(inRepo.length).toBeGreaterThan(0)
  })

  it('parseLabels correctly reads size and priority labels from discovered issues', async () => {
    const { fetchAssignedIssues } = await import('../src/github/projects.js')
    const { parseLabels } = await import('../src/scheduler/labels.js')
    const issues = await fetchAssignedIssues()
    for (const issue of issues.filter((i) => i.repoFullName === sandboxRepo)) {
      const { size, priority } = parseLabels(issue.labels)
      if (size) expect(['XS', 'S', 'M', 'L', 'XL']).toContain(size)
      expect(priority).toBeGreaterThanOrEqual(0)
      expect(priority).toBeLessThanOrEqual(3)
    }
  })
})
