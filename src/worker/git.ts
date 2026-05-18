import { execSync } from 'child_process'
import { env } from '../env.js'

export function stageAndCommit(workdir: string, message: string, authorName: string, authorEmail: string): void {
  execSync('git add -A', { cwd: workdir, stdio: 'pipe' })
  const safeMsg = message.replace(/"/g, '\\"')
  const safeAuthor = `${authorName} <${authorEmail}>`
  execSync(`git -c user.name="${authorName}" -c user.email="${authorEmail}" commit --author="${safeAuthor}" -m "${safeMsg}"`, {
    cwd: workdir,
    stdio: 'pipe',
  })
}

export function pushBranch(workdir: string, branchName: string, repoFullName: string): void {
  const token = env.GITHUB_PAT ?? ''
  const authedUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`
  execSync(`git remote set-url origin "${authedUrl}"`, { cwd: workdir, stdio: 'pipe' })
  execSync(`git push origin "${branchName}"`, {
    cwd: workdir,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 60_000,
  })
}

export function getDiffStat(workdir: string): string {
  try {
    return execSync('git diff HEAD~1 HEAD --stat', { cwd: workdir, stdio: 'pipe' }).toString().trim()
  } catch {
    return ''
  }
}

export function getDiff(workdir: string): string {
  try {
    return execSync('git diff HEAD~1 HEAD', { cwd: workdir, stdio: 'pipe' }).toString().trim()
  } catch {
    return ''
  }
}

export function getDiffLineCount(workdir: string): number {
  try {
    const stat = execSync('git diff HEAD --stat', { cwd: workdir, stdio: 'pipe' }).toString()
    const ins = stat.match(/(\d+) insertion/)
    const del = stat.match(/(\d+) deletion/)
    return parseInt(ins?.[1] ?? '0') + parseInt(del?.[1] ?? '0')
  } catch {
    return 0
  }
}

export function getWorkingDiff(workdir: string): string {
  try {
    return execSync('git diff HEAD', { cwd: workdir, stdio: 'pipe' }).toString().trim()
  } catch {
    return ''
  }
}

export function getChangedFiles(workdir: string): string[] {
  try {
    return execSync('git diff HEAD --name-only', { cwd: workdir, stdio: 'pipe' })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}
