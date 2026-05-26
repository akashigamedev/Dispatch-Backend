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

export async function setupRevisionWorkspace(
  taskId: number,
  repoFullName: string,
  branchName: string,
): Promise<string> {
  const dir = workspacePath(taskId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const cloneUrl = getCloneUrl(repoFullName)
  execSync(`git clone --depth 50 --branch "${branchName}" "${cloneUrl}" .`, {
    cwd: dir,
    stdio: 'pipe',
    timeout: 120_000,
  })

  return dir
}

export interface MultiRepoClone {
  repoId: number
  repoFullName: string
  baseBranch: string
  branchName: string
  workdir: string
}

// Clone N repos into subdirs of the task workspace, each on its own feature branch
// off the supplied base branch. Returns the parent workspace path and the per-repo
// subdir layout so the caller can drive per-repo phases.
export async function setupMultiWorkspace(
  taskId: number,
  repos: Array<{ repoId: number; repoFullName: string; baseBranch: string }>,
): Promise<{ workspaceRoot: string; clones: MultiRepoClone[] }> {
  const root = workspacePath(taskId)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const clones: MultiRepoClone[] = []
  for (const r of repos) {
    // subdir name = the repo's short name (after the slash). Two repos with the same
    // short name from different owners would collide; guard against that by appending
    // the repo id when needed.
    const shortName = r.repoFullName.split('/').pop() ?? `repo-${r.repoId}`
    const taken = clones.some((c) => c.workdir.endsWith(`/${shortName}`))
    const dirName = taken ? `${shortName}-${r.repoId}` : shortName
    const dir = join(root, dirName)
    mkdirSync(dir, { recursive: true })

    const cloneUrl = getCloneUrl(r.repoFullName)
    execSync(`git clone --depth 50 --branch "${r.baseBranch}" "${cloneUrl}" .`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 120_000,
    })

    const planningBranch = `dispatch/task-${taskId}-${r.repoId}-planning`
    execSync(`git checkout -b "${planningBranch}" "origin/${r.baseBranch}"`, { cwd: dir, stdio: 'pipe' })

    clones.push({
      repoId: r.repoId,
      repoFullName: r.repoFullName,
      baseBranch: r.baseBranch,
      branchName: planningBranch,
      workdir: dir,
    })
  }

  return { workspaceRoot: root, clones }
}

export function cleanupWorkspace(taskId: number): void {
  try {
    rmSync(workspacePath(taskId), { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

