const RETRIABLE_STATUSES = new Set([429, 500, 502, 503])
const RATE_LIMIT_MESSAGES = ['rate limit exceeded', 'secondary rate limit']

interface OctokitLike {
  status?: number
  message?: string
  response?: { headers?: Record<string, string> }
}

function isRetriable(err: unknown): boolean {
  const e = err as OctokitLike
  if (!e?.status) return false
  if (RETRIABLE_STATUSES.has(e.status)) return true
  if (e.status === 403) {
    const msg = (e.message ?? '').toLowerCase()
    return RATE_LIMIT_MESSAGES.some((kw) => msg.includes(kw))
  }
  return false
}

function retryDelayMs(err: unknown, attempt: number): number {
  const headers = (err as OctokitLike)?.response?.headers ?? {}
  const raw = headers['retry-after'] ?? headers['x-ratelimit-reset']
  if (raw) {
    const n = parseInt(raw)
    // Unix timestamp vs relative seconds
    return n > 1_000_000_000 ? Math.max(0, n * 1000 - Date.now()) : n * 1000
  }
  return Math.min(1000 * 2 ** attempt, 60_000)
}

export async function withGithubRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries && isRetriable(err)) {
        await new Promise((r) => setTimeout(r, retryDelayMs(err, attempt)))
        continue
      }
      throw err
    }
  }
  throw lastErr
}
