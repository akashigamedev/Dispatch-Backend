import { getOctokit } from './client.js'
import { withGithubRetry } from '../util/githubRetry.js'

export async function commentOnIssue(
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const [owner, repo] = repoFullName.split('/')
  const octokit = getOctokit()
  await withGithubRetry(() =>
    octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body }),
  )
}

export async function closeIssue(
  repoFullName: string,
  issueNumber: number,
): Promise<void> {
  const [owner, repo] = repoFullName.split('/')
  const octokit = getOctokit()
  await withGithubRetry(() =>
    octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' }),
  )
}
