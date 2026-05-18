import { z } from 'zod'
import { spawnClaude, usageFromResult, type UsageSummary, type ClaudeEffort } from './client.js'
import { log } from '../log.js'

const reviewSchema = z.object({
  decision: z.enum(['ship', 'fix', 'abort']),
  notes: z.string(),
})

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
    'Your job is to review an AI coding agent\'s diff against its plan and emit a structured JSON verdict.',
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your final assistant message MUST be a single JSON object and NOTHING ELSE.',
    'Do NOT reply with a bare word like "Ship." or any prose, summaries, or code fences.',
    'The downstream caller parses your message with JSON.parse — any non-JSON characters cause the task to fail.',
    '',
    'JSON shape (all fields required):',
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
    appendSystemPrompt:
      'You are a review subagent invoked by an automated pipeline. Your final message must be a single valid JSON object matching the schema in the user prompt — no prose, no bare verdict words, no markdown fences. The orchestrator parses this output programmatically.',
    outputFormat: 'json',
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
