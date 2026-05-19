import { execSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { env } from '../env.js'

const BASE = process.env.WORKSPACE_DIR ?? '/tmp/dispatch'

export function workspacePath(taskId: number): string {
  return join(BASE, String(taskId))
}

function getCloneUrl(repoFullName: string): string {
  const token = env.GITHUB_PAT ?? ''
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`
}

export async function setupWorkspace(
  taskId: number,
  repoFullName: string,
  baseBranch: string,
  branchName: string,
): Promise<string> {
  const dir = workspacePath(taskId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const cloneUrl = getCloneUrl(repoFullName)
  execSync(`git clone --depth 50 --branch "${baseBranch}" "${cloneUrl}" .`, {
    cwd: dir,
    stdio: 'pipe',
    timeout: 120_000,
  })
  execSync(`git checkout -b "${branchName}" "origin/${baseBranch}"`, { cwd: dir, stdio: 'pipe' })

  return dir
}

export function cleanupWorkspace(taskId: number): void {
  try {
    rmSync(workspacePath(taskId), { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

