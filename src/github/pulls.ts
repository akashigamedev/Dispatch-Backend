import { getOctokit } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'
import type { VerifyResult } from '../worker/verify.js'

export interface OpenPROptions {
  repoFullName: string
  baseBranch: string
  branchName: string
  issueNumber: number
  issueTitle: string
  githubLogin: string
  planMd: string
  diffSummary: string
  verifyResult: VerifyResult
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface OpenPRResult {
  prUrl: string
  prNumber: number
}

function buildVerificationLines(verifyResult: VerifyResult): string {
  if (verifyResult.steps.length === 0) return '- ⚠️ no verify steps configured'
  return verifyResult.steps
    .map((s) => {
      const icon = s.passed ? '✅' : s.required ? '❌' : '⚠️'
      return `- ${icon} ${s.name}`
    })
    .join('\n')
}

function buildPRBody(opts: OpenPROptions): string {
  return [
    '## Linked issue',
    `Closes #${opts.issueNumber}`,
    '',
    '## Plan',
    opts.planMd,
    '',
    '## Changes',
    opts.diffSummary || '_no diff stat available_',
    '',
    '## Verification',
    buildVerificationLines(opts.verifyResult),
    '',
    '## Skipped / TODO',
    '- (none)',
    '',
    '---',
    `Tokens: ${opts.tokensIn}/${opts.tokensOut} · Cost: $${opts.costUsd.toFixed(4)}`,
  ].join('\n')
}

export async function openPR(opts: OpenPROptions): Promise<OpenPRResult> {
  const [owner, repo] = opts.repoFullName.split('/')
  const octokit = getOctokit()

  const { data } = await withGithubRetry(() => octokit.rest.pulls.create({
    owner,
    repo,
    title: opts.issueTitle,
    head: opts.branchName,
    base: opts.baseBranch,
    body: buildPRBody(opts),
  }))

  return { prUrl: data.html_url, prNumber: data.number }
}
