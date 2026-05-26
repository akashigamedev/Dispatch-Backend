import { and, eq } from 'drizzle-orm'
import { db, profiles, tasks, taskLogs } from '../db/index.js'
import { runCoderLoop } from '../claude/coder.js'
import { planMultiRepoTask, type MultiRepoSubplan } from '../claude/planner.js'
import { reviewTask } from '../claude/reviewer.js'
import { createIssueForCompletedTask } from '../github/createIssue.js'
import { log } from '../log.js'
import { detectModelLimit } from '../util/claudeError.js'
import type { ClaudeEffort } from '../claude/client.js'
import {
  CancelError,
  clearCancel,
  getAbortSignal,
  isCancelRequested,
  setCurrentTask,
} from './cancel.js'
import {
  stageAndCommit,
  pushBranch,
  pushBranchTo,
  getDiffStat,
  getDiffLineCount,
  getChangedFiles,
  getWorkingDiff,
  renameBranch,
} from './git.js'
import { setupMultiWorkspace, cleanupWorkspace, type MultiRepoClone } from './workspace.js'
import { loadDispatchConfig, runAllVerifySteps } from './verify.js'
import type { TaskRepoEntry, RepoPhaseStatus } from '../types/multiRepo.js'

interface ProfileModels {
  planner?: { id?: string; thinking?: string }
  coder?: { id?: string; thinking?: string }
  sizer?: { id?: string; thinking?: string }
  reviewer?: { id?: string; thinking?: string }
}

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
function toEffort(raw: string | undefined, fallback: ClaudeEffort): ClaudeEffort {
  return (VALID_EFFORTS as readonly string[]).includes(raw ?? '') ? (raw as ClaudeEffort) : fallback
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '(.+)')
    .replace(/\*/g, '([^/]+)')
  return new RegExp(`^${escaped}$`)
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(filePath))
}

async function addLog(taskId: number, level: string, message: string): Promise<void> {
  await db.insert(taskLogs).values({ task_id: taskId, level, message })
}

async function repoLog(taskId: number, repoFullName: string, level: string, message: string): Promise<void> {
  await addLog(taskId, level, `[${repoFullName}] ${message}`)
}

function checkCancel(taskId: number): void {
  if (isCancelRequested(taskId)) throw new CancelError()
}

async function setRepoState(
  taskId: number,
  repoEntries: TaskRepoEntry[],
  repoId: number,
  patch: Partial<TaskRepoEntry>,
): Promise<void> {
  const entry = repoEntries.find((e) => e.repo_id === repoId)
  if (!entry) return
  Object.assign(entry, patch)
  await db.update(tasks).set({ repos: repoEntries }).where(eq(tasks.id, taskId))
}

/**
 * Topologically sort a list of repos by depends_on, returning the order they
 * should be coded. Repos are processed in waves but executed sequentially within
 * a wave to keep the single-task isRunning invariant intact.
 */
function topoOrder(entries: TaskRepoEntry[]): number[] {
  const remaining = new Map(entries.map((e) => [e.repo_id, new Set(e.depends_on)]))
  const out: number[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (ready.length === 0) throw new Error('runMulti: dependency cycle detected at runtime')
    ready.sort((a, b) => a - b)
    for (const id of ready) {
      out.push(id)
      remaining.delete(id)
    }
    for (const [, deps] of remaining) {
      for (const id of ready) deps.delete(id)
    }
  }
  return out
}

export async function runMultiRepoTask(taskId: number, userId: string): Promise<void> {
  setCurrentTask(taskId)

  try {
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

    const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId))

    if (!task || !profile) {
      log.error({ taskId, userId }, 'runMultiRepoTask: missing task or profile')
      return
    }

    if (task.kind !== 'multi') {
      log.error({ taskId, kind: task.kind }, 'runMultiRepoTask called on non-multi task')
      return
    }

    const title = task.title
    const description = task.description ?? ''
    const projectNodeId = task.project_node_id_target
    if (!projectNodeId) {
      throw new Error('multi task missing project_node_id_target')
    }
    if (!task.repos || !Array.isArray(task.repos) || task.repos.length === 0) {
      throw new Error('multi task has no repos')
    }

    const repoEntries: TaskRepoEntry[] = JSON.parse(JSON.stringify(task.repos)) as TaskRepoEntry[]

    const models = (profile.models ?? {}) as ProfileModels
    const plannerModelId = models.planner?.id ?? 'claude-opus-4-7'
    const plannerEffort = toEffort(models.planner?.thinking, 'medium')
    const coderModelId = models.coder?.id ?? 'claude-sonnet-4-6'
    const coderEffort = toEffort(models.coder?.thinking, 'medium')
    const reviewerModelId = models.reviewer?.id ?? 'claude-opus-4-7'
    const reviewerEffort = toEffort(models.reviewer?.thinking, 'low')

    let totalIn = 0
    let totalOut = 0
    let totalCost = 0

    // ── 1. Setup: clone every repo into a sibling subdir ─────────────────────
    await db.update(tasks).set({ status: 'planning', started_at: new Date() }).where(eq(tasks.id, taskId))
    await addLog(taskId, 'info', `Cloning ${repoEntries.length} repo(s)`)

    const { workspaceRoot, clones } = await setupMultiWorkspace(
      taskId,
      repoEntries.map((e) => ({ repoId: e.repo_id, repoFullName: e.full_name, baseBranch: e.base_branch })),
    )
    const cloneByRepoId = new Map(clones.map((c) => [c.repoId, c]))
    await addLog(taskId, 'info', 'Workspace ready')

    // ── 2. Plan across all repos in one shot ─────────────────────────────────
    checkCancel(taskId)
    await addLog(taskId, 'info', `Planning multi-repo task with ${plannerModelId}`)

    const plan = await planMultiRepoTask(
      workspaceRoot,
      repoEntries.map((e) => {
        const c = cloneByRepoId.get(e.repo_id)!
        return { repo_id: e.repo_id, full_name: e.full_name, subdir: c.workdir.split('/').pop()! }
      }),
      title,
      description,
      plannerModelId,
      plannerEffort,
    )
    totalIn += plan.usage.inputTokens
    totalOut += plan.usage.outputTokens
    totalCost += plan.usage.costUsd
    await addLog(taskId, 'claude', `Plan ready — confidence: ${plan.confidence.toFixed(2)}`)

    if (plan.confidence < 0.5 || plan.clarifying_questions.length > 0) {
      await db.update(tasks)
        .set({
          status: 'awaiting_input',
          finished_at: new Date(),
          contract_md: plan.contract_md,
          cost_usd: totalCost.toFixed(4),
          tokens_in: totalIn,
          tokens_out: totalOut,
        })
        .where(eq(tasks.id, taskId))
      for (const q of plan.clarifying_questions) {
        await addLog(taskId, 'warn', `Clarification needed: ${q}`)
      }
      await addLog(taskId, 'info', 'Awaiting clarification')
      return
    }

    // Merge per-repo subplan into our repoEntries; rename feature branches now that we have slugs.
    for (const sub of plan.repos) {
      const entry = repoEntries.find((e) => e.repo_id === sub.repo_id)
      if (!entry) continue
      entry.depends_on = sub.depends_on
      entry.plan_md = sub.plan_md
      entry.files_to_touch = sub.files_to_touch
      entry.branch_slug = sub.branch_slug
      entry.change_type = sub.change_type
      entry.commit_title = sub.commit_title
      entry.commit_body = sub.commit_body

      const clone = cloneByRepoId.get(entry.repo_id)
      if (clone) {
        const newBranch = `${sub.change_type}/multi-${taskId}-${sub.branch_slug}`
        renameBranch(clone.workdir, clone.branchName, newBranch)
        clone.branchName = newBranch
        entry.branch_name = newBranch
      }
    }
    await db.update(tasks).set({
      contract_md: plan.contract_md,
      repos: repoEntries,
    }).where(eq(tasks.id, taskId))

    // ── 3. Per-repo execution in topological order ───────────────────────────
    const order = topoOrder(repoEntries)
    await addLog(taskId, 'info', `Execution order: ${order.map((id) => repoEntries.find((e) => e.repo_id === id)?.full_name).join(' → ')}`)

    // Track diffs from upstream repos so downstream coders can see what was actually built.
    const upstreamDiffs = new Map<number, { repoFullName: string; diff: string }>()

    for (const repoId of order) {
      const entry = repoEntries.find((e) => e.repo_id === repoId)!
      const clone = cloneByRepoId.get(repoId)!
      const plannedSub = plan.repos.find((p) => p.repo_id === repoId)!

      try {
        await runOneRepo({
          taskId, userId, task, profile, plan, entry, clone, plannedSub,
          coderModelId, coderEffort, reviewerModelId, reviewerEffort,
          upstreamDiffs, repoEntries,
          addUsage: (u) => { totalIn += u.inputTokens; totalOut += u.outputTokens; totalCost += u.costUsd },
        })
      } catch (err) {
        if (err instanceof CancelError) throw err
        const reason = err instanceof Error ? err.message : String(err)
        await setRepoState(taskId, repoEntries, repoId, { status: 'failed', failure_reason: reason })
        await repoLog(taskId, entry.full_name, 'error', `Failed: ${reason}`)
        throw new Error(`repo ${entry.full_name} failed: ${reason}`)
      }
    }

    // ── 4. All repos done → create one issue per repo at "Code Review" ───────
    if (profile.dangerous_mode === true) {
      await db.update(tasks).set({
        status: 'done',
        repos: repoEntries,
        finished_at: new Date(),
        cost_usd: totalCost.toFixed(4),
        tokens_in: totalIn,
        tokens_out: totalOut,
      }).where(eq(tasks.id, taskId))
      await addLog(taskId, 'info', 'Multi-repo task complete (dangerous mode — pushed directly to base branches, no issues created)')
      log.info({ taskId, repoCount: repoEntries.length, totalCost }, 'multi-repo task complete (dangerous mode)')
      return
    }

    await addLog(taskId, 'info', `All repos succeeded — creating ${repoEntries.length} Code Review issue(s)`)
    for (const entry of repoEntries) {
      try {
        const issueBody = [
          entry.commit_body ?? '',
          '',
          entry.pr_url ? `**Pull request:** ${entry.pr_url}` : '',
          '',
          '---',
          '',
          '_Auto-created by Dispatch after AI implementation completed across all repos in this multi-repo task._',
        ].filter(Boolean).join('\n')
        const issue = await createIssueForCompletedTask({
          repoFullName: entry.full_name,
          title: entry.commit_title ?? `multi-repo task ${taskId}`,
          body: issueBody,
          projectNodeId,
          statusOptionName: 'Code Review',
        })
        entry.issue_node_id = issue.issueNodeId
        entry.issue_number = issue.issueNumber
        entry.issue_url = issue.issueUrl
        await repoLog(taskId, entry.full_name, 'info', `Issue created at Code Review: ${issue.issueUrl}`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await repoLog(taskId, entry.full_name, 'warn', `Could not create completion issue: ${reason}`)
        // Do not fail the task — the PR was opened. The user can create the issue manually.
      }
    }

    await db.update(tasks).set({
      status: 'done',
      repos: repoEntries,
      finished_at: new Date(),
      cost_usd: totalCost.toFixed(4),
      tokens_in: totalIn,
      tokens_out: totalOut,
    }).where(eq(tasks.id, taskId))

    await addLog(taskId, 'info', 'Multi-repo task complete')
    log.info({ taskId, repoCount: repoEntries.length, totalCost }, 'multi-repo task complete')
  } catch (err) {
    if (err instanceof CancelError || isCancelRequested(taskId)) {
      await db.update(tasks).set({ status: 'cancelled', finished_at: new Date() }).where(eq(tasks.id, taskId)).catch(() => null)
      await addLog(taskId, 'info', 'Task cancelled').catch(() => null)
    } else {
      const limitInfo = detectModelLimit(err)
      if (limitInfo) {
        await db.update(profiles)
          .set({ anthropic_resume_after: limitInfo.resumeAfter })
          .where(eq(profiles.id, userId))
          .catch(() => null)
        if (limitInfo.kind === 'rate_limit') {
          await db.update(tasks)
            .set({ status: 'queued', started_at: null })
            .where(eq(tasks.id, taskId))
            .catch(() => null)
          await addLog(taskId, 'warn', `Rate limited — re-queued. Will auto-resume at ${limitInfo.resumeAfter?.toISOString()}.`).catch(() => null)
          return
        }
        await addLog(taskId, 'error', `Claude usage limit hit — clocked out.`).catch(() => null)
      }
      const reason = err instanceof Error ? err.message : String(err)
      log.error({ err, taskId }, 'multi-repo task failed')
      await db.update(tasks).set({ status: 'failed', failure_reason: reason, finished_at: new Date() }).where(eq(tasks.id, taskId)).catch(() => null)
      await addLog(taskId, 'error', `Failed: ${reason}`).catch(() => null)
    }
  } finally {
    cleanupWorkspace(taskId)
    clearCancel(taskId)
    setCurrentTask(null)
  }
}

interface RunOneRepoArgs {
  taskId: number
  userId: string
  task: typeof tasks.$inferSelect
  profile: typeof profiles.$inferSelect
  plan: Awaited<ReturnType<typeof planMultiRepoTask>>
  entry: TaskRepoEntry
  clone: MultiRepoClone
  plannedSub: MultiRepoSubplan
  coderModelId: string
  coderEffort: ClaudeEffort
  reviewerModelId: string
  reviewerEffort: ClaudeEffort
  upstreamDiffs: Map<number, { repoFullName: string; diff: string }>
  repoEntries: TaskRepoEntry[]
  addUsage: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void
}

async function runOneRepo(a: RunOneRepoArgs): Promise<void> {
  const { taskId, task, profile, plan, entry, clone, plannedSub, coderModelId, coderEffort, reviewerModelId, reviewerEffort, upstreamDiffs, repoEntries, addUsage } = a
  const repoFullName = entry.full_name

  checkCancel(taskId)
  await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'coding' })
  await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))
  await repoLog(taskId, repoFullName, 'info', `Coding with ${coderModelId}`)

  // Build per-repo coder prompt: the contract + this repo's subplan + diffs of any upstream
  // dependencies (so the FE coder sees what the BE coder actually shipped, not just what was planned).
  const upstreamContext = entry.depends_on.length === 0
    ? ''
    : entry.depends_on
        .map((depId) => {
          const u = upstreamDiffs.get(depId)
          if (!u) return ''
          return `### Upstream diff for ${u.repoFullName}\n\`\`\`diff\n${u.diff.slice(0, 8000)}\n\`\`\``
        })
        .filter(Boolean)
        .join('\n\n')

  const planMd = [
    `## Cross-repo contract\n${plan.contract_md}`,
    upstreamContext ? `## Upstream implementations (already merged into their respective branches)\n${upstreamContext}` : '',
    `## Plan for this repo (${repoFullName})\n${plannedSub.plan_md}`,
  ].filter(Boolean).join('\n\n')

  const coderResult = await runCoderLoop(
    clone.workdir,
    taskId,
    plannedSub.commit_title,
    task.description,
    planMd,
    plannedSub.files_to_touch,
    coderModelId,
    coderEffort,
    undefined,
    getAbortSignal(taskId),
  )
  addUsage(coderResult.usage)

  // ── Verify ───────────────────────────────────────────────────────────────
  checkCancel(taskId)
  const dispatchConfig = loadDispatchConfig(clone.workdir)
  const maxDiff = dispatchConfig.max_diff_lines ?? 800

  const diffLines = getDiffLineCount(clone.workdir)
  if (diffLines > maxDiff) {
    throw new Error(`diff too large (${diffLines} lines > ${maxDiff})`)
  }
  if (dispatchConfig.paths_off_limits?.length) {
    const changed = getChangedFiles(clone.workdir)
    const blocked = changed.filter((f) => matchesAnyGlob(f, dispatchConfig.paths_off_limits!))
    if (blocked.length > 0) throw new Error(`edited protected path(s): ${blocked.join(', ')}`)
  }

  await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'verifying' })
  await db.update(tasks).set({ status: 'verifying' }).where(eq(tasks.id, taskId))
  await repoLog(taskId, repoFullName, 'info', 'Running verify steps')

  let verifyResult = runAllVerifySteps(clone.workdir, dispatchConfig)
  if (!verifyResult.passed && verifyResult.failedStep) {
    await repoLog(taskId, repoFullName, 'warn', `Verify failed: ${verifyResult.failedStep.name} — retrying with coder`)
    const fixNotes = `The following verify step failed:\n\`${verifyResult.failedStep.run}\`\n\nOutput (last 200 lines):\n${verifyResult.failedStep.output}`

    await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'coding' })
    await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))
    const fixResult = await runCoderLoop(
      clone.workdir, taskId, plannedSub.commit_title, task.description, planMd,
      plannedSub.files_to_touch, coderModelId, coderEffort, fixNotes, getAbortSignal(taskId),
    )
    addUsage(fixResult.usage)

    await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'verifying' })
    await db.update(tasks).set({ status: 'verifying' }).where(eq(tasks.id, taskId))
    verifyResult = runAllVerifySteps(clone.workdir, dispatchConfig)
    if (!verifyResult.passed && verifyResult.failedStep) {
      throw new Error(`verify failed: ${verifyResult.failedStep.name}`)
    }
  }
  await repoLog(taskId, repoFullName, 'info', 'Verify passed')

  if (getDiffLineCount(clone.workdir) === 0) {
    throw new Error('coder produced no changes')
  }

  // ── Review ───────────────────────────────────────────────────────────────
  checkCancel(taskId)
  await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'reviewing' })
  await db.update(tasks).set({ status: 'reviewing' }).where(eq(tasks.id, taskId))
  await repoLog(taskId, repoFullName, 'info', `Reviewing with ${reviewerModelId}`)

  const workingDiff = getWorkingDiff(clone.workdir)
  const reviewResult = await reviewTask(planMd, workingDiff, reviewerModelId, reviewerEffort)
  addUsage(reviewResult.usage)
  await repoLog(taskId, repoFullName, 'claude', `Review: ${reviewResult.decision} — ${reviewResult.notes}`)

  if (reviewResult.decision === 'abort') {
    throw new Error(`reviewer aborted: ${reviewResult.notes}`)
  }

  if (reviewResult.decision === 'fix') {
    await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'coding' })
    await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))
    const fixResult = await runCoderLoop(
      clone.workdir, taskId, plannedSub.commit_title, task.description, planMd,
      plannedSub.files_to_touch, coderModelId, coderEffort, reviewResult.notes, getAbortSignal(taskId),
    )
    addUsage(fixResult.usage)

    await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'verifying' })
    verifyResult = runAllVerifySteps(clone.workdir, dispatchConfig)
    if (!verifyResult.passed && verifyResult.failedStep) {
      throw new Error(`verify failed after reviewer fix: ${verifyResult.failedStep.name}`)
    }
  }

  // ── Push + PR ────────────────────────────────────────────────────────────
  checkCancel(taskId)
  await setRepoState(taskId, repoEntries, entry.repo_id, { status: 'pushing' })
  await db.update(tasks).set({ status: 'pushing' }).where(eq(tasks.id, taskId))

  const authorEmail = `${profile.github_user_id}+${profile.github_login}@users.noreply.github.com`
  const commitMsg = plannedSub.commit_body
    ? `${plannedSub.commit_title}\n\n${plannedSub.commit_body}`
    : plannedSub.commit_title
  stageAndCommit(clone.workdir, commitMsg, profile.github_login, authorEmail)
  await repoLog(taskId, repoFullName, 'info', `Committed: ${plannedSub.commit_title}`)

  const dangerous = profile.dangerous_mode === true
  const diffSummary = getDiffStat(clone.workdir)

  if (dangerous) {
    await repoLog(taskId, repoFullName, 'warn', `DANGEROUS MODE: pushing directly to ${entry.base_branch} (skipping PR)`)
    pushBranchTo(clone.workdir, clone.branchName, entry.base_branch, repoFullName)
    await repoLog(taskId, repoFullName, 'info', `Pushed → ${entry.base_branch}`)

    upstreamDiffs.set(entry.repo_id, { repoFullName, diff: getDiff(clone.workdir) })
    await setRepoState(taskId, repoEntries, entry.repo_id, {
      status: 'done' as RepoPhaseStatus,
      diff_summary: diffSummary,
    })
    return
  }

  pushBranch(clone.workdir, clone.branchName, repoFullName)
  await repoLog(taskId, repoFullName, 'info', `Pushed ${clone.branchName}`)

  const { prUrl, prNumber } = await openPRMulti({
    repoFullName,
    baseBranch: entry.base_branch,
    branchName: clone.branchName,
    commitTitle: plannedSub.commit_title,
    commitBody: plannedSub.commit_body,
  })

  await repoLog(taskId, repoFullName, 'info', `PR opened: ${prUrl}`)

  upstreamDiffs.set(entry.repo_id, { repoFullName, diff: getDiff(clone.workdir) })

  await setRepoState(taskId, repoEntries, entry.repo_id, {
    status: 'done' as RepoPhaseStatus,
    pr_url: prUrl,
    pr_number: prNumber,
    diff_summary: diffSummary,
  })
}

// Local copy of openPR without the "Closes #N" trailer — multi-repo PRs have no upstream issue.
import { getOctokit } from '../github/client.js'
import { withGithubRetry } from '../util/githubRetry.js'
import { getDiff } from './git.js'

async function openPRMulti(opts: {
  repoFullName: string
  baseBranch: string
  branchName: string
  commitTitle: string
  commitBody: string
}): Promise<{ prUrl: string; prNumber: number }> {
  const [owner, repo] = opts.repoFullName.split('/')
  const octokit = getOctokit()
  const { data } = await withGithubRetry(() => octokit.rest.pulls.create({
    owner,
    repo,
    title: opts.commitTitle,
    head: opts.branchName,
    base: opts.baseBranch,
    body: opts.commitBody,
  }))
  return { prUrl: data.html_url, prNumber: data.number }
}
