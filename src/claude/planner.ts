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
 * Plan a task. Runs in Claude Code's `plan` permission mode — the agent can
 * read the workspace freely (Glob/Grep/Read/Bash for read-only commands) but
 * physically cannot mutate files. Output is enforced against PLAN_JSON_SCHEMA.
 */
export async function planTask(
  workdir: string,
  title: string,
  body: string | null,
  modelId = 'claude-opus-4-7',
  effort: ClaudeEffort = 'medium',
): Promise<PlanResult> {
  const prompt = [
    'You are planning the implementation of a GitHub issue.',
    'Explore the repository using Read, Glob, and Grep as needed to understand the codebase.',
    'If a CLAUDE.md exists at the repo root, read it first for project conventions.',
    '',
    'When ready, output ONLY a JSON object with this exact shape:',
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
    permissionMode: 'plan',
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
