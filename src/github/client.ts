import type { Octokit } from '@octokit/rest'
import { getPatOctokit, patGraphql } from './pat.js'
import { env } from '../env.js'

// Resolution order: GitHub App install token → PAT → error.
// M3: PAT only. GitHub App installation token resolved in M3+ when installation_id is set.
export function getOctokit(): Octokit {
  if (env.GITHUB_PAT) return getPatOctokit()
  throw new Error('no GitHub credentials configured')
}

export function getGraphql() {
  if (env.GITHUB_PAT) return patGraphql
  throw new Error('no GitHub credentials configured')
}
