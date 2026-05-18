import { z } from 'zod'
import { spawnClaude, usageFromResult, type UsageSummary, type ClaudeEffort } from './client.js'
import { log } from '../log.js'

const reviewSchema = z.object({
  decision: z.enum(['ship', 'fix', 'abort']),
  notes: z.string(),
})

const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['ship', 'fix', 'abort'] },
    notes: { type: 'string' },
  },
  required: ['decision', 'notes'],
  additionalProperties: false,
}

export interface ReviewResult {
  decision: 'ship' | 'fix' | 'abort'
  notes: string
  usage: UsageSummary
}

export async function reviewTask(
  planMd: string,
  diff: string,
  modelId = 'claude-opus-4-7',
  effort: ClaudeEffort = 'low',
): Promise<ReviewResult> {
  const prompt = [
    'You are a code reviewer for an AI coding agent. Given the implementation plan and the resulting git diff, decide whether to ship, fix, or abort.',
    '',
    'Output ONLY a JSON object with this exact shape:',
    '{ "decision": "ship" | "fix" | "abort", "notes": "..." }',
    '',
    '- "ship": the diff correctly implements the plan — proceed to open a PR',
    '- "fix": there are specific, concrete issues the coder should fix (describe them in notes)',
    '- "abort": the approach is fundamentally wrong or too risky (explain in notes)',
    '',
    'Be pragmatic. Prefer "ship" if the implementation is reasonable. Use "fix" only for concrete fixable problems. Use "abort" only for fundamental issues.',
    '',
    `## Plan\n${planMd}`,
    '',
    `## Diff\n\`\`\`diff\n${diff.slice(0, 20000)}\n\`\`\``,
  ].join('\n')

  const r = await spawnClaude({
    prompt,
    model: modelId,
    effort,
    tools: 'none',
    outputFormat: 'json',
    jsonSchema: REVIEW_JSON_SCHEMA,
  })

  let parsed: z.infer<typeof reviewSchema>
  try {
    const jsonMatch = r.result.match(/\{[\s\S]*\}/)
    parsed = reviewSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
  } catch {
    log.warn({ raw: r.result.slice(0, 500) }, 'reviewer: could not parse JSON — defaulting to ship')
    parsed = { decision: 'ship', notes: 'Could not parse reviewer response; defaulting to ship.' }
  }

  return { ...parsed, usage: usageFromResult(r) }
}
