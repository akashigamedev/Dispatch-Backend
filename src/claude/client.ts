import { spawn } from 'child_process'
import { log } from '../log.js'

/**
 * Wrapper around the `claude` CLI in non-interactive (`-p`) mode.
 *
 * Auth comes from the CLI's own credentials (`claude setup-token` or interactive
 * login on this machine). The server never sees an API key.
 */

export type ClaudePermissionMode = 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'dontAsk'
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ClaudeOutputFormat = 'text' | 'json' | 'stream-json'

export interface ClaudeSpawnOptions {
  prompt: string
  model: string
  cwd?: string
  permissionMode?: ClaudePermissionMode
  /** Whitelist tools by name (e.g. ['Read', 'Edit', 'Bash']). If unset, all tools allowed. */
  allowedTools?: string[]
  /** Use `[]` to disable all tools, or list specific tools. Mutually exclusive with allowedTools. */
  tools?: string[] | 'default' | 'none'
  maxTurns?: number
  appendSystemPrompt?: string
  effort?: ClaudeEffort
  outputFormat?: ClaudeOutputFormat
  /** JSON Schema for structured output. CLI enforces it via `--json-schema`. */
  jsonSchema?: object
  /** Extra dirs to grant tool access to (beyond cwd). */
  addDir?: string[]
  /** Max USD budget for this single invocation. */
  maxBudgetUsd?: number
  /** Streaming event callback (only with outputFormat='stream-json'). */
  onEvent?: (event: ClaudeStreamEvent) => void
  /** Aborts the subprocess (SIGTERM). */
  signal?: AbortSignal
}

export interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    role?: 'assistant' | 'user'
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
    }>
  }
  result?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  [key: string]: unknown
}

export interface ClaudeResult {
  /** Final assistant text (the `result` field from the CLI's terminal event). */
  result: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  /** Raw terminal event from the CLI — useful for diagnostics. */
  terminalEvent: ClaudeStreamEvent | null
}

export class ClaudeCliError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly terminalEvent: ClaudeStreamEvent | null,
    message?: string,
  ) {
    super(message ?? `claude CLI exited ${exitCode}: ${stderr.slice(0, 500)}`)
    this.name = 'ClaudeCliError'
  }
}

function buildArgs(opts: ClaudeSpawnOptions): string[] {
  const args: string[] = ['-p', '--model', opts.model, '--no-session-persistence']

  const fmt = opts.outputFormat ?? 'json'
  args.push('--output-format', fmt)
  if (fmt === 'stream-json') args.push('--verbose')

  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }

  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','))

  if (opts.tools !== undefined) {
    if (opts.tools === 'none') args.push('--tools', '')
    else if (opts.tools === 'default') args.push('--tools', 'default')
    else if (Array.isArray(opts.tools)) args.push('--tools', opts.tools.length === 0 ? '' : opts.tools.join(','))
  }

  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema))
  if (opts.addDir?.length) args.push('--add-dir', ...opts.addDir)
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', opts.maxBudgetUsd.toFixed(4))

  return args
}

export async function spawnClaude(opts: ClaudeSpawnOptions): Promise<ClaudeResult> {
  const args = buildArgs(opts)
  const started = Date.now()

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdoutBuf = ''
    let stderr = ''
    let terminal: ClaudeStreamEvent | null = null
    const fmt = opts.outputFormat ?? 'json'

    const onAbort = (): void => {
      child.kill('SIGTERM')
      // Hard-kill if it doesn't exit within 3s.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 3000)
    }
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      if (fmt === 'stream-json') {
        stdoutBuf += chunk
        let nl: number
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line) as ClaudeStreamEvent
            if (event.type === 'result') terminal = event
            opts.onEvent?.(event)
          } catch (e) {
            log.warn({ line: line.slice(0, 200), err: String(e) }, 'spawnClaude: bad stream-json line')
          }
        }
      } else {
        stdoutBuf += chunk
      }
    })

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new ClaudeCliError(null, String(err), null, `failed to spawn claude: ${err.message}`))
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)

      if (fmt !== 'stream-json') {
        // Non-streaming: stdoutBuf holds the final JSON object (or text).
        if (fmt === 'json') {
          try {
            terminal = JSON.parse(stdoutBuf.trim()) as ClaudeStreamEvent
          } catch (e) {
            return reject(new ClaudeCliError(code, stderr, null, `bad JSON from claude: ${String(e)} — raw: ${stdoutBuf.slice(0, 300)}`))
          }
        } else {
          terminal = { type: 'result', subtype: 'success', result: stdoutBuf.trim() }
        }
      }

      if (code !== 0 || terminal?.subtype === 'error_during_execution' || terminal?.subtype === 'error_max_turns') {
        return reject(new ClaudeCliError(code, stderr, terminal, `claude failed (exit ${code}, subtype ${terminal?.subtype ?? 'n/a'}): ${stderr.slice(0, 300)}`))
      }

      const usage = terminal?.usage ?? {}
      resolve({
        result: terminal?.result ?? '',
        costUsd: terminal?.total_cost_usd ?? 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        durationMs: Date.now() - started,
        terminalEvent: terminal,
      })
    })

    // Send prompt via stdin to dodge ARG_MAX limits on long prompts.
    child.stdin.write(opts.prompt)
    child.stdin.end()
  })
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function usageFromResult(r: ClaudeResult): UsageSummary {
  return { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd }
}
