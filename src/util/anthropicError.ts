import Anthropic from '@anthropic-ai/sdk'

export type AnthropicLimitKind = 'rate_limit' | 'usage_limit'

export interface AnthropicLimitInfo {
  kind: AnthropicLimitKind
  /** null for usage/billing limits where resume time is unknown */
  resumeAfter: Date | null
  message: string
}

const USAGE_KEYWORDS = ['credit', 'usage', 'limit', 'quota', 'insufficient', 'billing', 'balance']

export function detectAnthropicLimit(err: unknown): AnthropicLimitInfo | null {
  if (err instanceof Anthropic.RateLimitError) {
    const headerVal = (err.headers as Record<string, string> | undefined)?.['retry-after']
    const retryAfterSecs = headerVal ? (parseInt(headerVal) || 60) : 60
    return {
      kind: 'rate_limit',
      resumeAfter: new Date(Date.now() + retryAfterSecs * 1000),
      message: `rate limited — retry-after ${retryAfterSecs}s`,
    }
  }

  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.AuthenticationError) {
    const msg = (err.message ?? '').toLowerCase()
    if (USAGE_KEYWORDS.some((kw) => msg.includes(kw))) {
      return {
        kind: 'usage_limit',
        resumeAfter: null,
        message: err.message,
      }
    }
  }

  return null
}
