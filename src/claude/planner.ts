import { z } from 'zod'
import { spawnClaude, usageFromResult, type UsageSummary, type ClaudeEffort } from './client.js'
import { log } from '../log.js'

const planSchema = z.object({
  plan_md: z.string(),
  confidence: z.number().min(0).max(1),
  files_to_touch: z.array(z.string()).default([]),
  clarifying_questions: z.array(z.string()).default([]),
})

const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    plan_md: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    files_to_touch: { type: 'array', items: { type: 'string' } },
    clarifying_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['plan_md', 'confidence', 'files_to_touch', 'clarifying_questions'],
  additionalProperties: false,
}

export interface PlanResult {
  plan_md: string
  confidence: number
  files_to_touch: string[]
  clarifying_questions: string[]
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
    'Your job is to produce a structured JSON implementation plan for the GitHub issue below.',
    'Explore the repository with Read/Glob/Grep as needed. Read CLAUDE.md at the repo root first if it exists.',
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your final assistant message MUST be a single JSON object and NOTHING ELSE.',
    'Do NOT prefix or suffix it with prose, summaries, code fences, or phrases like "Plan delivered" / "Plan saved".',
    'The downstream caller parses your message with JSON.parse — any non-JSON characters cause the task to fail.',
    '',
    'JSON shape (all fields required):',
    '{',
    '  "plan_md": "markdown plan with clear, ordered steps",',
    '  "confidence": 0.0,         // 0.0-1.0; < 0.5 means you need clarification',
    '  "files_to_touch": [],      // file paths likely to be modified',
    '  "clarifying_questions": [] // non-empty ONLY if confidence < 0.5',
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
    jsonSchema: PLAN_JSON_SCHEMA,
    maxTurns: 30,
  })

  let parsed: z.infer<typeof planSchema>
  try {
    const jsonMatch = r.result.match(/\{[\s\S]*\}/)
    parsed = planSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
  } catch {
    log.warn({ raw: r.result.slice(0, 500), title }, 'planner: could not parse JSON response')
    parsed = {
      plan_md: r.result || 'No plan generated.',
      confidence: 0.3,
      files_to_touch: [],
      clarifying_questions: ['Unable to parse plan — please review the issue manually.'],
    }
  }

  return { ...parsed, usage: usageFromResult(r) }
}
