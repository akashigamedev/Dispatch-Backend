import { z } from 'zod'
import { spawnClaude, usageFromResult, type UsageSummary, type ClaudeEffort } from './client.js'
import { log } from '../log.js'

export type TaskSize = 'XS' | 'S' | 'M' | 'L' | 'XL'

const sizeSchema = z.object({ size: z.enum(['XS', 'S', 'M', 'L', 'XL']) })

const SIZE_JSON_SCHEMA = {
  type: 'object',
  properties: { size: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL'] } },
  required: ['size'],
  additionalProperties: false,
}

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
  effort: ClaudeEffort = 'low',
): Promise<SizerResult> {
  const prompt = [PROMPT_PREFIX, '', `Issue: ${title}`, body ?? ''].join('\n').trim()

  const r = await spawnClaude({
    prompt,
    model: modelId,
    effort,
    tools: 'none',
    outputFormat: 'json',
    jsonSchema: SIZE_JSON_SCHEMA,
  })

  let size: TaskSize = 'M'
  try {
    const jsonMatch = r.result.match(/\{[^}]+\}/)
    const parsed = sizeSchema.parse(JSON.parse(jsonMatch?.[0] ?? r.result))
    size = parsed.size
  } catch {
    log.warn({ raw: r.result.slice(0, 300), title }, 'sizer: could not parse response, defaulting to M')
  }

  return { size, usage: usageFromResult(r) }
}
