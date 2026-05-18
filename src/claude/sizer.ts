import { z } from 'zod'
import { anthropic, estimateCost, type UsageSummary } from './client.js'
import { log } from '../log.js'

export type TaskSize = 'XS' | 'S' | 'M' | 'L' | 'XL'

const sizeSchema = z.object({ size: z.enum(['XS', 'S', 'M', 'L', 'XL']) })

const PROMPT_PREFIX = [
  'You are sizing a GitHub issue for an AI coding agent.',
  'Respond ONLY with JSON: { "size": "XS" | "S" | "M" | "L" | "XL" }',
  '',
  'Size guide:',
  '  XS — trivial: one-liner, config tweak, doc fix (<30 min)',
  '  S  — small: clear scope, 1-3 files, straightforward implementation (<2h)',
  '  M  — medium: multi-file, some design decisions, may touch tests (<4h)',
  '  L  — large: significant feature or refactor, cross-cutting concerns (<1d)',
  '  XL — too large: epic or scope > 1 day — human should decompose',
].join('\n')

export interface SizerResult {
  size: TaskSize
  usage: UsageSummary
}

export async function sizeTask(
  title: string,
  body: string | null,
  modelId = 'claude-opus-4-7',
): Promise<SizerResult> {
  const content = [PROMPT_PREFIX, '', `Issue: ${title}`, body ?? ''].join('\n').trim()

  const response = await anthropic.messages.create({
    model: modelId,
    max_tokens: 64,
    messages: [{ role: 'user', content }],
  })

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens

  const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  let size: TaskSize = 'M'
  try {
    const jsonMatch = raw.match(/\{[^}]+\}/)
    const parsed = sizeSchema.parse(JSON.parse(jsonMatch?.[0] ?? raw))
    size = parsed.size
  } catch {
    log.warn({ raw, title }, 'sizer: could not parse response, defaulting to M')
  }

  return { size, usage: { inputTokens, outputTokens, costUsd: estimateCost(modelId, inputTokens, outputTokens) } }
}
