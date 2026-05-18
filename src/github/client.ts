import type { Octokit } from '@octokit/rest'
import { getPatOctokit, patGraphql } from './pat.js'

export function getOctokit(): Octokit {
  return getPatOctokit()
}

export function getGraphql() {
  return patGraphql
}
