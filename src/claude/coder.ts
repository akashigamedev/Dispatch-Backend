import { db, taskLogs } from '../db/index.js'
import { log } from '../log.js'
import {
  spawnClaude,
  usageFromResult,
  type ClaudeEffort,
  type ClaudeStreamEvent,
  type UsageSummary,
} from './client.js'

export interface CoderResult {
  summary: string
  usage: UsageSummary
}

const CODER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']

async function addLog(taskId: number, level: string, message: string): Promise<void> {
  await db.insert(taskLogs).values({ task_id: taskId, level, message })
}

/**
 * Stream the coder's tool calls + reasoning into task_logs.
 *
 * Claude Code emits stream-json events with assistant content blocks
 * (text + tool_use) and user content blocks (tool_result). We mirror those
 * into the existing log schema so the task detail screen keeps working.
 */
function handleStreamEvent(taskId: number, event: ClaudeStreamEvent): void {
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        void addLog(taskId, 'claude', block.text.trim().slice(0, 2000)).catch(() => null)
      } else if (block.type === 'tool_use') {
        const argStr = JSON.stringify(block.input ?? {}).slice(0, 300)
        void addLog(taskId, 'cmd', `${block.name ?? '?'}(${argStr})`).catch(() => null)
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const txt = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        void addLog(taskId, 'cmd', `→ ${txt.slice(0, 500)}`).catch(() => null)
      }
    }
  }
}

export async function runCoderLoop(
  workdir: string,
  taskId: number,
  issueTitle: string,
  issueBody: string | null,
  planMd: string,
  filesToTouch: string[],
  modelId = 'claude-sonnet-4-6',
  effort: ClaudeEffort = 'low',
  fixNotes?: string,
  signal?: AbortSignal,
): Promise<CoderResult> {
  const systemAppend = [
    'You are implementing a GitHub issue inside an ephemeral workspace clone.',
    'Read files before modifying them. Use Edit for surgical changes and Write only for new files.',
    'Use Bash for git diff / git status checks and to run project tooling, but do not push or commit — the worker handles that.',
    'When all changes for the plan are complete, end your turn with a short summary line.',
    filesToTouch.length > 0 ? `Files likely to touch: ${filesToTouch.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const prompt = [
    `## Issue: ${issueTitle}`,
    issueBody ?? '',
    '',
    '## Implementation plan',
    planMd,
    fixNotes ? `\n## Fix required\n${fixNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const r = await spawnClaude({
    prompt,
    model: modelId,
    cwd: workdir,
    addDir: [workdir],
    permissionMode: 'bypassPermissions',
    allowedTools: CODER_TOOLS,
    appendSystemPrompt: systemAppend,
    effort,
    outputFormat: 'stream-json',
    maxTurns: 150,
    onEvent: (event) => handleStreamEvent(taskId, event),
    signal,
  })

  const summary = r.result.trim().slice(0, 500) || 'done'
  await addLog(taskId, 'info', `Coder finished: ${summary}`)

  log.info({ taskId, totalIn: r.inputTokens, totalOut: r.outputTokens, costUsd: r.costUsd }, 'coder loop complete')

  return { summary, usage: usageFromResult(r) }
}
