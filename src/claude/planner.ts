import { z } from 'zod'
import { spawnClaude, usageFromResult, type UsageSummary, type ClaudeEffort } from './client.js'
import { log } from '../log.js'
import { slugify } from '../util/slugify.js'

const CHANGE_TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'chore'] as const
type ChangeType = (typeof CHANGE_TYPES)[number]

const planSchema = z.object({
  plan_md: z.string(),
  confidence: z.number().min(0).max(1),
  files_to_touch: z.array(z.string()).default([]),
  clarifying_questions: z.array(z.string()).default([]),
  change_type: z.enum(CHANGE_TYPES),
  branch_slug: z.string().regex(/^[a-z0-9-]+$/).max(40),
  commit_title: z.string().max(72),
  commit_body: z.string(),
})

export interface PlanResult {
  plan_md: string
  confidence: number
  files_to_touch: string[]
  clarifying_questions: string[]
  change_type: ChangeType
  branch_slug: string
  commit_title: string
  commit_body: string
  usage: UsageSummary
}

/**
 * Plan a task. Write tools (Edit/Write/NotebookEdit) are disallowed so the
 * agent can explore freely but cannot mutate files. We avoid `plan` permission
 * mode because it hijacks final output with an ExitPlanMode summary, breaking
 * the JSON schema we enforce here.
 */
export async function planTask(
  workdir: string,
  title: string,
  body: string | null,
  modelId = 'claude-opus-4-7',
  effort: ClaudeEffort = 'medium',
): Promise<PlanResult> {
  const prompt = [
    'Your job is to produce a structured JSON implementation plan for the GitHub issue below,',
    'AND the public-facing commit metadata that will be shown to end users in a changelog.',
    'Explore the repository with Read/Glob/Grep as needed. Read CLAUDE.md at the repo root first if it exists.',
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your final assistant message MUST be a single JSON object and NOTHING ELSE.',
    'Do NOT prefix or suffix it with prose, summaries, code fences, or phrases like "Plan delivered" / "Plan saved".',
    'The downstream caller parses your message with JSON.parse — any non-JSON characters cause the task to fail.',
    '',
    'JSON shape (all fields required):',
    '{',
    '  "plan_md": "markdown plan with clear, ordered steps (engineering detail)",',
    '  "confidence": 0.0,         // 0.0-1.0; < 0.5 means you need clarification',
    '  "files_to_touch": [],      // file paths likely to be modified',
    '  "clarifying_questions": [],// non-empty ONLY if confidence < 0.5',
    '  "change_type": "feat",     // one of: feat|fix|docs|refactor|perf|test|chore',
    '  "branch_slug": "...",      // kebab-case, <=40 chars, user-facing intent (no type prefix, no issue number)',
    '  "commit_title": "...",     // "<change_type>: <summary>", <=72 chars, lowercase imperative, user-facing',
    '  "commit_body": "..."       // markdown, see shape below',
    '}',
    '',
    'COMMIT METADATA RULES — these strings are what end users read in a release changelog,',
    'NOT what an engineer sees. Write from the USER\'S point of view.',
    '',
    '- change_type: pick based on the user-visible nature of the change, not the file types touched.',
    '',
    '- branch_slug: kebab-case [a-z0-9-]+, <=40 chars, derived from the user-facing summary',
    '  (NOT the raw issue title). No type prefix, no issue number.',
    '  Good: "deduplicate-queued-tasks", "export-issues-as-csv"',
    '  Bad:  "refactor-poller-to-dedupe-inflight", "fix-142-add-metrics"',
    '',
    '- commit_title: "<change_type>: <summary>". Summary is lowercase, imperative, <=60 chars,',
    '  written from the user\'s POV. NEVER mention file/class/function names.',
    '  Good: "feat: prevent the same task from being picked up twice"',
    '  Bad:  "feat: Refactor poller to deduplicate inflight tasks; add metrics"',
    '',
    '- commit_body: plain-language markdown for a non-engineer reader. Shape:',
    '  1) One sentence lede stating the user-visible problem or context.',
    '  2) Blank line, then "What\'s new:" followed by 2-4 bullets, each a concrete',
    '     user-visible change in present tense, benefit-led.',
    '  3) For tiny changes with only one user-visible thing to say, emit the lede',
    '     only and omit the "What\'s new:" section.',
    '  Do NOT mention file names, function names, class names, or implementation detail.',
    '  Do NOT include "Closes #N" — the worker appends that as a trailer.',
    '',
    'EXAMPLE (for an issue titled "Refactor poller to deduplicate inflight tasks; add metrics"):',
    '{',
    '  "change_type": "feat",',
    '  "branch_slug": "deduplicate-queued-tasks",',
    '  "commit_title": "feat: prevent the same task from being picked up twice",',
    '  "commit_body": "Tasks queued in rapid succession could occasionally be picked up by two workers at once, causing duplicate PRs.\\n\\nWhat\'s new:\\n- Each task is now guaranteed to run exactly once, even under burst load\\n- Queue health (depth, in-flight count, stalled tasks) is visible in the metrics endpoint\\n- Stuck tasks are auto-recovered on worker restart instead of being silently dropped",',
    '  ...',
    '}',
    '',
    `## Issue: ${title}`,
    body ?? '',
  ].join('\n')

  const r = await spawnClaude({
    prompt,
    model: modelId,
    cwd: workdir,
    addDir: [workdir],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    appendSystemPrompt:
      'You are a planning subagent invoked by an automated pipeline. Your final message must be a single valid JSON object matching the schema in the user prompt — no prose, no markdown fences, no preamble, no trailing summary. The orchestrator parses this output programmatically.',
    effort,
    outputFormat: 'json',
    maxTurns: 100,
  })

  let parsed: z.infer<typeof planSchema>
  try {
    const jsonMatch = r.result.match(/\{[\s\S]*\}/)
    parsed = planSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
  } catch {
    log.warn({ raw: r.result.slice(0, 500), title }, 'planner: could not parse JSON response')
    const fallbackSlug = slugify(title).slice(0, 40) || 'task'
    parsed = {
      plan_md: r.result || 'No plan generated.',
      confidence: 0.3,
      files_to_touch: [],
      clarifying_questions: ['Unable to parse plan — please review the issue manually.'],
      change_type: 'chore',
      branch_slug: fallbackSlug,
      commit_title: `chore: ${title}`.slice(0, 72),
      commit_body: title,
    }
  }

  return { ...parsed, usage: usageFromResult(r) }
}

const multiRepoSubplanSchema = z.object({
  repo_id: z.number(),
  depends_on: z.array(z.number()).default([]),
  plan_md: z.string(),
  files_to_touch: z.array(z.string()).default([]),
  branch_slug: z.string().regex(/^[a-z0-9-]+$/).max(40),
  change_type: z.enum(CHANGE_TYPES),
  commit_title: z.string().max(72),
  commit_body: z.string(),
})

const multiRepoPlanSchema = z.object({
  contract_md: z.string(),
  repos: z.array(multiRepoSubplanSchema).min(1),
  confidence: z.number().min(0).max(1),
  clarifying_questions: z.array(z.string()).default([]),
})

export type MultiRepoSubplan = z.infer<typeof multiRepoSubplanSchema>

export interface MultiRepoPlanResult {
  contract_md: string
  repos: MultiRepoSubplan[]
  confidence: number
  clarifying_questions: string[]
  usage: UsageSummary
}

export async function planMultiRepoTask(
  workspaceRoot: string,
  repos: Array<{ repo_id: number; full_name: string; subdir: string }>,
  title: string,
  description: string,
  modelId = 'claude-opus-4-7',
  effort: ClaudeEffort = 'medium',
): Promise<MultiRepoPlanResult> {
  const repoList = repos
    .map((r) => `- repo_id=${r.repo_id}, full_name=${r.full_name}, subdir=./${r.subdir}`)
    .join('\n')

  const prompt = [
    'You are planning a coordinated change that spans MULTIPLE repositories that have been cloned',
    'side-by-side into subdirectories of the current working directory.',
    'Explore each repo with Read/Glob/Grep as needed. Read each repo\'s CLAUDE.md at its root if present.',
    '',
    'Your job is to:',
    '  1) Design an explicit CONTRACT (API surface, shared types, integration points) that the repos must agree on.',
    '  2) Emit a per-repo subplan that references that contract.',
    '  3) Declare cross-repo dependencies: which repos must finish coding before others can start',
    '     (typically the backend repo that exposes an API must finish before the frontend that consumes it).',
    '',
    'REPOS IN THIS TASK:',
    repoList,
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your final assistant message MUST be a single JSON object and NOTHING ELSE.',
    'No prose, no code fences, no preamble or trailing summary.',
    '',
    'JSON shape (all fields required):',
    '{',
    '  "contract_md": "markdown spec of the cross-repo contract: endpoints/types/integration points that the repos must agree on",',
    '  "repos": [',
    '    {',
    '      "repo_id": <number>,           // must match one of the repo_ids above',
    '      "depends_on": [<repo_id>, ...], // repo_ids that must finish coding BEFORE this repo. [] for leaf repos.',
    '      "plan_md": "markdown plan for THIS repo only, referencing the contract above",',
    '      "files_to_touch": ["path/relative/to/THIS/repo"],',
    '      "branch_slug": "kebab-case, <=40 chars, user-facing intent (no type prefix, no issue number)",',
    '      "change_type": "feat" | "fix" | "docs" | "refactor" | "perf" | "test" | "chore",',
    '      "commit_title": "<change_type>: <summary>",  // <=72 chars, lowercase imperative, user-facing',
    '      "commit_body": "..."                          // markdown, plain language for end users'
    , '    }',
    '  ],',
    '  "confidence": 0.0,                  // 0.0-1.0; < 0.5 means you need clarification',
    '  "clarifying_questions": []          // non-empty ONLY if confidence < 0.5',
    '}',
    '',
    'RULES:',
    '- depends_on must be a DAG (no cycles). Typically: frontend depends on backend.',
    '- branch_slug, commit_title, commit_body — same user-POV rules as single-repo planning: no file/class names, lowercase imperative, user-visible language.',
    '- files_to_touch paths must be relative to that repo\'s own root (not to the workspace root).',
    '- The contract_md is the SINGLE SOURCE OF TRUTH for cross-repo agreements. Be precise: endpoint signatures, request/response shapes, shared type names, error semantics.',
    '',
    `## Task title\n${title}`,
    '',
    `## Task description\n${description}`,
  ].join('\n')

  const r = await spawnClaude({
    prompt,
    model: modelId,
    cwd: workspaceRoot,
    addDir: [workspaceRoot],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    appendSystemPrompt:
      'You are a multi-repo planning subagent invoked by an automated pipeline. Your final message must be a single valid JSON object matching the schema in the user prompt — no prose, no markdown fences. The orchestrator parses this output programmatically.',
    effort,
    outputFormat: 'json',
    maxTurns: 150,
  })

  const parsed: z.infer<typeof multiRepoPlanSchema> = (() => {
    try {
      const jsonMatch = r.result.match(/\{[\s\S]*\}/)
      return multiRepoPlanSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
    } catch {
      log.warn({ raw: r.result.slice(0, 500) }, 'multi-repo planner: could not parse JSON response')
      return {
        contract_md: r.result || 'No contract generated.',
        repos: repos.map((re) => ({
          repo_id: re.repo_id,
          depends_on: [],
          plan_md: 'Plan could not be parsed automatically.',
          files_to_touch: [],
          branch_slug: 'task',
          change_type: 'chore' as const,
          commit_title: 'chore: multi-repo task',
          commit_body: description,
        })),
        confidence: 0.3,
        clarifying_questions: ['Unable to parse multi-repo plan — please review manually.'],
      }
    }
  })()

  // Validate: every subplan's repo_id is one we asked about; depends_on references valid repo_ids; no cycles.
  const knownIds = new Set(repos.map((r) => r.repo_id))
  for (const sub of parsed.repos) {
    if (!knownIds.has(sub.repo_id)) {
      throw new Error(`planner returned unknown repo_id ${sub.repo_id}`)
    }
    for (const dep of sub.depends_on) {
      if (!knownIds.has(dep)) {
        throw new Error(`planner: repo ${sub.repo_id} depends_on unknown repo_id ${dep}`)
      }
      if (dep === sub.repo_id) {
        throw new Error(`planner: repo ${sub.repo_id} cannot depend on itself`)
      }
    }
  }
  // Cycle detection (Kahn-style).
  const inDegree = new Map<number, number>()
  parsed.repos.forEach((s) => inDegree.set(s.repo_id, s.depends_on.length))
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited += 1
    for (const sub of parsed.repos) {
      if (sub.depends_on.includes(id)) {
        const d = (inDegree.get(sub.repo_id) ?? 0) - 1
        inDegree.set(sub.repo_id, d)
        if (d === 0) queue.push(sub.repo_id)
      }
    }
  }
  if (visited !== parsed.repos.length) {
    throw new Error('planner: depends_on contains a cycle')
  }

  return { ...parsed, usage: usageFromResult(r) }
}

const revisionPlanSchema = z.object({
  plan_md: z.string(),
  confidence: z.number().min(0).max(1),
  files_to_touch: z.array(z.string()).default([]),
  clarifying_questions: z.array(z.string()).default([]),
  commit_title: z.string().max(72),
  commit_body: z.string(),
})

export interface RevisionPlanResult {
  plan_md: string
  confidence: number
  files_to_touch: string[]
  clarifying_questions: string[]
  commit_title: string
  commit_body: string
  usage: UsageSummary
}

export async function planRevision(
  workdir: string,
  title: string,
  body: string | null,
  previousPlan: string,
  previousDiffSummary: string | null,
  feedback: string,
  modelId = 'claude-opus-4-7',
  effort: ClaudeEffort = 'medium',
): Promise<RevisionPlanResult> {
  const prompt = [
    'You are revising an existing pull request based on review feedback.',
    'The repository is already checked out on the branch that holds the prior implementation.',
    'Use Read/Glob/Grep/Bash (git diff, git log) to see what is already implemented before planning.',
    '',
    'Your job is to produce a focused JSON plan for ONLY the changes needed to address the feedback,',
    'plus a commit message for those changes.',
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your final assistant message MUST be a single JSON object and NOTHING ELSE.',
    'Do NOT prefix or suffix with prose, summaries, code fences, or any other text.',
    '',
    'JSON shape (all fields required):',
    '{',
    '  "plan_md": "markdown plan covering ONLY the revision (not a re-plan of the whole feature)",',
    '  "confidence": 0.0,         // 0.0-1.0; < 0.5 means you need clarification',
    '  "files_to_touch": [],      // file paths likely to be modified by this revision',
    '  "clarifying_questions": [],// non-empty ONLY if confidence < 0.5',
    '  "commit_title": "...",     // <=72 chars, lowercase imperative, describes the FIX from the user POV',
    '  "commit_body": "..."       // plain-language markdown summary of what this revision changes',
    '}',
    '',
    'commit_title MUST describe the revision itself, not the original feature.',
    '  Good: "fix: handle empty input in csv export"',
    '  Bad:  "feat: export issues as csv" (that was the previous commit)',
    '',
    'commit_body should be a short paragraph or 1-3 bullets describing what was wrong and what is now fixed.',
    'Do NOT mention file names, function names, or implementation detail.',
    'Do NOT include "Closes #N" — the worker handles trailers.',
    '',
    `## Issue: ${title}`,
    body ?? '',
    '',
    '## Previous implementation plan',
    previousPlan || '(no plan recorded)',
    '',
    previousDiffSummary ? `## Previous diff summary\n${previousDiffSummary}\n` : '',
    '## Reviewer feedback (this is what you must address)',
    feedback,
  ].filter(Boolean).join('\n')

  const r = await spawnClaude({
    prompt,
    model: modelId,
    cwd: workdir,
    addDir: [workdir],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    appendSystemPrompt:
      'You are a revision-planning subagent invoked by an automated pipeline. Your final message must be a single valid JSON object matching the schema in the user prompt — no prose, no markdown fences. The orchestrator parses this output programmatically.',
    effort,
    outputFormat: 'json',
    maxTurns: 100,
  })

  let parsed: z.infer<typeof revisionPlanSchema>
  try {
    const jsonMatch = r.result.match(/\{[\s\S]*\}/)
    parsed = revisionPlanSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
  } catch {
    log.warn({ raw: r.result.slice(0, 500), title }, 'revision planner: could not parse JSON response')
    const fallbackTitle = feedback.split('\n', 1)[0]!.trim().slice(0, 72) || 'apply review feedback'
    parsed = {
      plan_md: r.result || 'No revision plan generated.',
      confidence: 0.3,
      files_to_touch: [],
      clarifying_questions: ['Unable to parse revision plan — please review the feedback manually.'],
      commit_title: fallbackTitle,
      commit_body: feedback,
    }
  }

  return { ...parsed, usage: usageFromResult(r) }
}
