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
    maxTurns: 30,
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
