import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { anthropic, estimateCost, type UsageSummary } from './client.js'
import { log } from '../log.js'

const planSchema = z.object({
  plan_md: z.string(),
  confidence: z.number().min(0).max(1),
  files_to_touch: z.array(z.string()).default([]),
  clarifying_questions: z.array(z.string()).default([]),
})

export interface PlanResult {
  plan_md: string
  confidence: number
  files_to_touch: string[]
  clarifying_questions: string[]
  usage: UsageSummary
}

function thinkingBudget(level: string | undefined): number {
  if (level === 'high') return 16000
  if (level === 'medium') return 8000
  if (level === 'low') return 2048
  return 0
}

export async function planTask(
  title: string,
  body: string | null,
  repoTree: string,
  claudeMd: string,
  modelId = 'claude-opus-4-7',
  thinkingLevel = 'medium',
): Promise<PlanResult> {
  const budget = thinkingBudget(thinkingLevel)

  const prompt = [
    'You are a planning agent for an AI coding system. Given a GitHub issue, produce a detailed implementation plan.',
    'Output ONLY a JSON object with this exact shape:',
    '{',
    '  "plan_md": "...",',
    '  "confidence": 0.0,',
    '  "files_to_touch": [],',
    '  "clarifying_questions": []',
    '}',
    '',
    '- plan_md: markdown plan with clear steps',
    '- confidence: 0.0-1.0 (< 0.5 means you need clarification)',
    '- files_to_touch: list of file paths likely to be modified',
    '- clarifying_questions: non-empty only if confidence < 0.5',
    '',
    `## Issue: ${title}`,
    body ?? '',
    '',
    repoTree ? `## Repository files\n${repoTree}` : '',
    claudeMd ? `## CLAUDE.md\n${claudeMd}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: budget > 0 ? budget + 4096 : 4096,
    messages: [{ role: 'user', content: prompt }],
    ...(budget > 0 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
  }

  const response = await anthropic.messages.create(params)

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens

  const textBlock = response.content.find((b) => b.type === 'text')
  const raw = textBlock?.type === 'text' ? textBlock.text.trim() : ''

  let result: z.infer<typeof planSchema>
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    result = planSchema.parse(JSON.parse(jsonMatch?.[0] ?? raw))
  } catch {
    log.warn({ raw: raw.slice(0, 500), title }, 'planner: could not parse JSON response')
    result = { plan_md: raw || 'No plan generated.', confidence: 0.3, files_to_touch: [], clarifying_questions: ['Unable to parse plan — please review the issue manually.'] }
  }

  return {
    ...result,
    usage: { inputTokens, outputTokens, costUsd: estimateCost(modelId, inputTokens, outputTokens) },
  }
}
