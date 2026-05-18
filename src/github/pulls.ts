import { getOctokit } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'
import type { VerifyResult } from '../worker/verify.js'

export interface OpenPROptions {
  repoFullName: string
  baseBranch: string
  branchName: string
  issueNumber: number
  commitTitle: string
  commitBody: string
  githubLogin: string
}

export interface OpenPRResult {
  prUrl: string
  prNumber: number
}

function buildPRBody(opts: OpenPROptions): string {
  return `${opts.commitBody}\n\nCloses #${opts.issueNumber}`
}

export async function openPR(opts: OpenPROptions): Promise<OpenPRResult> {
  const [owner, repo] = opts.repoFullName.split('/')
  const octokit = getOctokit()

  const { data } = await withGithubRetry(() => octokit.rest.pulls.create({
    owner,
    repo,
    title: opts.commitTitle,
    head: opts.branchName,
    base: opts.baseBranch,
    body: buildPRBody(opts),
  }))

  return { prUrl: data.html_url, prNumber: data.number }
}

export function buildReviewerComment(verify: VerifyResult, planMd: string): string {
  const verifyLines = verify.steps.length === 0
    ? '- ⚠️ no verify steps configured'
    : verify.steps
      .map((s) => `- ${s.passed ? '✅' : s.required ? '❌' : '⚠️'} ${s.name}`)
      .join('\n')

  return [
    '## Verification',
    verifyLines,
    '',
    '<details>',
    '<summary>🦉 Implementation plan (engineering detail)</summary>',
    '',
    planMd,
    '',
    '</details>',
  ].join('\n')
}

export async function postPRComment(repoFullName: string, prNumber: number, body: string): Promise<void> {
  const [owner, repo] = repoFullName.split('/')
  const octokit = getOctokit()
  await withGithubRetry(() => octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  }))
}
