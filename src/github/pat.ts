import { Octokit } from '@octokit/rest'
import { graphql as githubGraphql } from '@octokit/graphql'
import { env } from '../env.js'

export function getPatOctokit(): Octokit {
  return new Octokit({ auth: env.GITHUB_PAT })
}

export const patGraphql = githubGraphql.defaults({
  headers: { authorization: `token ${env.GITHUB_PAT ?? ''}` },
})
