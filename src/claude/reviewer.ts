import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { anthropic, estimateCost, type UsageSummary } from './client.js'
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

function thinkingBudget(level: string | undefined): number {
  if (level === 'high') return 16000
  if (level === 'medium') return 8000
  if (level === 'low') return 2048
  return 0
}

export async function reviewTask(
  planMd: string,
  diff: string,
  modelId = 'claude-opus-4-7',
  thinkingLevel = 'low',
): Promise<ReviewResult> {
  const budget = thinkingBudget(thinkingLevel)

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

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: budget > 0 ? budget + 2048 : 2048,
    messages: [{ role: 'user', content: prompt }],
    ...(budget > 0 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
  }

  const response = await anthropic.messages.create(params)

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens

  const textBlock = response.content.find((b) => b.type === 'text')
  const raw = textBlock?.type === 'text' ? textBlock.text.trim() : ''

  let result: z.infer<typeof reviewSchema>
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    result = reviewSchema.parse(JSON.parse(jsonMatch?.[0] ?? raw))
  } catch {
    log.warn({ raw: raw.slice(0, 500) }, 'reviewer: could not parse JSON — defaulting to ship')
    result = { decision: 'ship', notes: 'Could not parse reviewer response; defaulting to ship.' }
  }

  return {
    ...result,
    usage: { inputTokens, outputTokens, costUsd: estimateCost(modelId, inputTokens, outputTokens) },
  }
}
