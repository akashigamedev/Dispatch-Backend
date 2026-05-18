import { and, eq } from 'drizzle-orm'
import { db, profiles, repos, tasks, taskLogs } from '../db/index.js'
import { addSpend, isBudgetExceeded } from '../scheduler/budget.js'
import { runCoderLoop } from '../claude/coder.js'
import { planTask } from '../claude/planner.js'
import { reviewTask } from '../claude/reviewer.js'
import { commentOnIssue } from '../github/issues.js'
import { openPR } from '../github/pulls.js'
import { log } from '../log.js'
import { slugify } from '../util/slugify.js'
import { detectModelLimit } from '../util/claudeError.js'
import type { ClaudeEffort } from '../claude/client.js'
import { CancelError, clearCancel, getAbortSignal, isCancelRequested, setCurrentTask } from './cancel.js'
import { stageAndCommit, pushBranch, getDiffStat, getDiffLineCount, getChangedFiles, getWorkingDiff } from './git.js'
import { setupWorkspace, cleanupWorkspace } from './workspace.js'
import { loadNightowlConfig, runAllVerifySteps } from './verify.js'

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

async function addLog(taskId: number, level: string, message: string): Promise<void> {
  await db.insert(taskLogs).values({ task_id: taskId, level, message })
}

function checkCancel(taskId: number): void {
  if (isCancelRequested(taskId)) throw new CancelError()
}

export async function runTask(taskId: number, userId: string): Promise<void> {
  setCurrentTask(taskId)
  let workdir: string | null = null

  try {
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.user_id, userId)))

    const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId))

    const [repo] = task.repo_id
      ? await db.select().from(repos).where(eq(repos.id, task.repo_id))
      : []

    if (!task || !profile || !repo) {
      log.error({ taskId, userId }, 'runTask: missing task, profile, or repo')
      return
    }

    checkCancel(taskId)

    const models = (profile.models ?? {}) as ProfileModels
    const branchName = `${repo.branch_prefix}${task.github_issue_number}-${slugify(task.title)}`

    let totalIn = 0
    let totalOut = 0
    let totalCost = 0

    // ── 1. Setup ──────────────────────────────────────────────────────────────
    await addLog(taskId, 'info', `Cloning ${repo.full_name} → ${branchName}`)
    await db.update(tasks).set({ status: 'planning', started_at: new Date(), branch_name: branchName }).where(eq(tasks.id, taskId))

    workdir = await setupWorkspace(taskId, repo.full_name, repo.base_branch, branchName)
    await addLog(taskId, 'info', 'Workspace ready')

    // ── 2. Plan ───────────────────────────────────────────────────────────────
    checkCancel(taskId)
    const plannerModelId = models.planner?.id ?? 'claude-opus-4-7'
    const plannerEffort = toEffort(models.planner?.thinking, 'medium')

    await addLog(taskId, 'info', `Planning with ${plannerModelId}`)
    const planResult = await planTask(workdir, task.title, task.body, plannerModelId, plannerEffort)

    totalIn += planResult.usage.inputTokens
    totalOut += planResult.usage.outputTokens
    totalCost += planResult.usage.costUsd
    await addSpend(userId, planResult.usage.costUsd)

    await db.update(tasks).set({ plan_md: planResult.plan_md }).where(eq(tasks.id, taskId))
    await addLog(taskId, 'claude', `Plan ready — confidence: ${planResult.confidence.toFixed(2)}`)

    if (planResult.confidence < 0.5 || planResult.clarifying_questions.length > 0) {
      const body = [
        '🦉 **Nightowl needs clarification before proceeding:**',
        '',
        ...planResult.clarifying_questions.map((q) => `- ${q}`),
        '',
        `_Confidence: ${(planResult.confidence * 100).toFixed(0)}%_`,
      ].join('\n')
      await commentOnIssue(repo.full_name, task.github_issue_number, body)
      await db.update(tasks)
        .set({ status: 'awaiting_input', finished_at: new Date(), cost_usd: totalCost.toFixed(4), tokens_in: totalIn, tokens_out: totalOut })
        .where(eq(tasks.id, taskId))
      await addLog(taskId, 'info', 'Awaiting clarification — commented on issue')
      return
    }

    // ── 3. Code ───────────────────────────────────────────────────────────────
    checkCancel(taskId)

    if (await isBudgetExceeded(userId)) {
      throw new Error('daily budget exceeded — task halted before coding')
    }

    const coderModelId = models.coder?.id ?? 'claude-sonnet-4-6'
    const coderEffort = toEffort(models.coder?.thinking, 'medium')

    await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))
    await addLog(taskId, 'info', `Coding with ${coderModelId}`)

    const coderResult = await runCoderLoop(
      workdir, taskId, task.title, task.body, planResult.plan_md,
      planResult.files_to_touch, coderModelId, coderEffort, undefined, getAbortSignal(taskId),
    )
    totalIn += coderResult.usage.inputTokens
    totalOut += coderResult.usage.outputTokens
    totalCost += coderResult.usage.costUsd
    await addSpend(userId, coderResult.usage.costUsd)

    // ── 4. Verify ─────────────────────────────────────────────────────────────
    checkCancel(taskId)
    const nightowlConfig = loadNightowlConfig(workdir)
    const maxDiff = nightowlConfig.max_diff_lines ?? 800

    const diffLines = getDiffLineCount(workdir)
    if (diffLines > maxDiff) {
      throw new Error(`diff too large (${diffLines} lines > ${maxDiff}) — needs human decomposition`)
    }

    if (nightowlConfig.paths_off_limits?.length) {
      const changed = getChangedFiles(workdir)
      const blocked = changed.filter((f) => matchesAnyGlob(f, nightowlConfig.paths_off_limits!))
      if (blocked.length > 0) throw new Error(`edited protected path(s): ${blocked.join(', ')}`)
    }

    await db.update(tasks).set({ status: 'verifying' }).where(eq(tasks.id, taskId))
    await addLog(taskId, 'info', 'Running verify steps')

    let verifyResult = runAllVerifySteps(workdir, nightowlConfig)

    if (!verifyResult.passed && verifyResult.failedStep) {
      await addLog(taskId, 'warn', `Verify failed: ${verifyResult.failedStep.name} — retrying with coder`)
      const fixNotes = `The following verify step failed:\n\`${verifyResult.failedStep.run}\`\n\nOutput (last 200 lines):\n${verifyResult.failedStep.output}`

      await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))
      const fixResult = await runCoderLoop(
        workdir, taskId, task.title, task.body, planResult.plan_md,
        planResult.files_to_touch, coderModelId, coderEffort, fixNotes, getAbortSignal(taskId),
      )
      totalIn += fixResult.usage.inputTokens
      totalOut += fixResult.usage.outputTokens
      totalCost += fixResult.usage.costUsd
      await addSpend(userId, fixResult.usage.costUsd)

      await db.update(tasks).set({ status: 'verifying' }).where(eq(tasks.id, taskId))
      verifyResult = runAllVerifySteps(workdir, nightowlConfig)

      if (!verifyResult.passed && verifyResult.failedStep) {
        throw new Error(`verify failed: ${verifyResult.failedStep.name}`)
      }
    }

    await addLog(taskId, 'info', 'All verify steps passed')

    // ── 5. Review ─────────────────────────────────────────────────────────────
    checkCancel(taskId)

    if (await isBudgetExceeded(userId)) {
      throw new Error('daily budget exceeded — task halted before review')
    }

    const reviewerModelId = models.reviewer?.id ?? 'claude-opus-4-7'
    const reviewerEffort = toEffort(models.reviewer?.thinking, 'low')

    await db.update(tasks).set({ status: 'reviewing' }).where(eq(tasks.id, taskId))
    await addLog(taskId, 'info', `Reviewing with ${reviewerModelId}`)

    const workingDiff = getWorkingDiff(workdir)
    const reviewResult = await reviewTask(planResult.plan_md, workingDiff, reviewerModelId, reviewerEffort)

    totalIn += reviewResult.usage.inputTokens
    totalOut += reviewResult.usage.outputTokens
    totalCost += reviewResult.usage.costUsd
    await addSpend(userId, reviewResult.usage.costUsd)

    await addLog(taskId, 'claude', `Review decision: ${reviewResult.decision} — ${reviewResult.notes}`)

    if (reviewResult.decision === 'abort') {
      throw new Error(`reviewer aborted: ${reviewResult.notes}`)
    }

    if (reviewResult.decision === 'fix') {
      await addLog(taskId, 'info', 'Reviewer requested fixes — running one more coder pass')
      await db.update(tasks).set({ status: 'coding' }).where(eq(tasks.id, taskId))

      const fixResult = await runCoderLoop(
        workdir, taskId, task.title, task.body, planResult.plan_md,
        planResult.files_to_touch, coderModelId, coderEffort, reviewResult.notes, getAbortSignal(taskId),
      )
      totalIn += fixResult.usage.inputTokens
      totalOut += fixResult.usage.outputTokens
      totalCost += fixResult.usage.costUsd
      await addSpend(userId, fixResult.usage.costUsd)

      await db.update(tasks).set({ status: 'verifying' }).where(eq(tasks.id, taskId))
      verifyResult = runAllVerifySteps(workdir, nightowlConfig)

      if (!verifyResult.passed && verifyResult.failedStep) {
        throw new Error(`verify failed after reviewer fix: ${verifyResult.failedStep.name}`)
      }
      await addLog(taskId, 'info', 'Post-fix verify passed')
    }

    // ── 6. Push ───────────────────────────────────────────────────────────────
    checkCancel(taskId)
    await db.update(tasks).set({ status: 'pushing' }).where(eq(tasks.id, taskId))

    const authorEmail = `${profile.github_user_id}+${profile.github_login}@users.noreply.github.com`
    const commitMsg = `feat: ${task.title}`
    stageAndCommit(workdir, commitMsg, profile.github_login, authorEmail)
    await addLog(taskId, 'info', `Committed: ${commitMsg}`)

    pushBranch(workdir, branchName, repo.full_name)
    await addLog(taskId, 'info', `Pushed ${branchName}`)

    const diffSummary = getDiffStat(workdir)
    const { prUrl, prNumber } = await openPR({
      repoFullName: repo.full_name,
      baseBranch: repo.base_branch,
      branchName,
      issueNumber: task.github_issue_number,
      issueTitle: task.title,
      githubLogin: profile.github_login,
      planMd: planResult.plan_md,
      verifyResult,
    })

    await db.update(tasks).set({
      status: 'done',
      pr_url: prUrl,
      pr_number: prNumber,
      diff_summary: diffSummary,
      finished_at: new Date(),
      cost_usd: totalCost.toFixed(4),
      tokens_in: totalIn,
      tokens_out: totalOut,
    }).where(eq(tasks.id, taskId))

    await addLog(taskId, 'info', `Done — PR: ${prUrl}`)
    log.info({ taskId, prUrl, totalCost }, 'task complete')

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
        log.warn({ userId, kind: limitInfo.kind, resumeAfter: limitInfo.resumeAfter }, 'Claude limit — pausing worker until resume_after')

        if (limitInfo.kind === 'rate_limit') {
          await db.update(tasks)
            .set({ status: 'queued', started_at: null, branch_name: null })
            .where(eq(tasks.id, taskId))
            .catch(() => null)
          await addLog(taskId, 'warn', `Rate limited — re-queued. Will auto-resume at ${limitInfo.resumeAfter?.toISOString()}.`).catch(() => null)
          return
        }

        await addLog(taskId, 'error', `Claude usage limit hit — clocked out. Clock in manually once resolved.`).catch(() => null)
      }
      const reason = err instanceof Error ? err.message : String(err)
      log.error({ err, taskId }, 'task failed')
      await db.update(tasks).set({ status: 'failed', failure_reason: reason, finished_at: new Date() }).where(eq(tasks.id, taskId)).catch(() => null)
      await addLog(taskId, 'error', `Failed: ${reason}`).catch(() => null)
    }
  } finally {
    if (workdir) cleanupWorkspace(taskId)
    clearCancel(taskId)
    setCurrentTask(null)
  }
}
