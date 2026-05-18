import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env.js'

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

// Rough cost per 1M tokens.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7':   { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5':  { input: 0.8,  output: 4.0  },
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 15.0, output: 75.0 }
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
}
