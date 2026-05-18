import { ClaudeCliError } from '../claude/client.js'

/**
 * Detects "throttled by the model provider" failures from `claude` CLI output.
 *
 * Kept as a loose heuristic over stderr + the CLI's terminal event: Claude Code
 * doesn't emit machine-readable error codes the way the SDK did, so we pattern-
 * match the human-readable messages it prints when a Claude subscription's
 * 5-hour or weekly limit kicks in, or when the network is rate-limited.
 */

export type ModelLimitKind = 'rate_limit' | 'usage_limit'

export interface ModelLimitInfo {
  kind: ModelLimitKind
  /** null when the reset time isn't parseable from the error. */
  resumeAfter: Date | null
  message: string
}

const USAGE_PATTERNS = [
  /usage limit/i,
  /weekly limit/i,
  /5-hour limit/i,
  /insufficient (credits|balance|quota)/i,
  /quota exceeded/i,
  /upgrade your plan/i,
]

const RATE_PATTERNS = [/rate limit/i, /too many requests/i, /429/]

// "Your limit will reset at 2024-01-15T10:00:00Z" / "resets at 3:45 PM"
const RESET_ISO_RE = /reset(?:s| at|ting at)?[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+\-Z]+)/i
const RESET_EPOCH_RE = /reset(?:s)?\s*(?:at)?\s*(?:in\s*)?(\d+)\s*(s|sec|seconds|m|min|minutes|h|hr|hours)/i

function parseResetTime(text: string): Date | null {
  const isoMatch = text.match(RESET_ISO_RE)
  if (isoMatch) {
    const d = new Date(isoMatch[1])
    if (!Number.isNaN(d.getTime())) return d
  }

  const relMatch = text.match(RESET_EPOCH_RE)
  if (relMatch) {
    const n = parseInt(relMatch[1], 10)
    const unit = relMatch[2].toLowerCase()
    const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60_000 : n * 3_600_000
    return new Date(Date.now() + ms)
  }

  return null
}

export function detectModelLimit(err: unknown): ModelLimitInfo | null {
  if (!(err instanceof ClaudeCliError)) return null

  const haystack = [
    err.stderr,
    err.message,
    err.terminalEvent ? JSON.stringify(err.terminalEvent).slice(0, 2000) : '',
  ].join('\n')

  const rateHit = RATE_PATTERNS.some((re) => re.test(haystack))
  const usageHit = USAGE_PATTERNS.some((re) => re.test(haystack))

  if (!rateHit && !usageHit) return null

  const parsedReset = parseResetTime(haystack)

  if (rateHit) {
    return {
      kind: 'rate_limit',
      resumeAfter: parsedReset ?? new Date(Date.now() + 60_000),
      message: 'claude CLI rate-limited',
    }
  }

  return {
    kind: 'usage_limit',
    resumeAfter: parsedReset,
    message: 'claude CLI usage limit hit',
  }
}
