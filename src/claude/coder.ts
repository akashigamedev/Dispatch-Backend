import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, estimateCost, type UsageSummary } from './client.js'
import { db, taskLogs } from '../db/index.js'
import { log } from '../log.js'

export interface CoderResult {
  summary: string
  usage: UsageSummary
}

// Commands that the coder is allowed to run.
const ALLOWED_COMMAND_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git blame', 'git ls-files', 'git stash',
  'npm ', 'npx ', 'pnpm ', 'yarn ', 'bun ',
  'pip ', 'pip3 ', 'poetry ', 'uv ',
  'cargo ', 'go build', 'go test', 'go run', 'go vet', 'go fmt',
  './gradlew',
  'node ', 'python ', 'python3 ', 'ts-node ', 'tsx ',
  'cat ', 'ls', 'find ', 'grep ', 'head ', 'tail ', 'wc ', 'diff ',
  'echo ', 'mkdir ', 'touch ', 'mv ', 'cp ',
  'which ', 'pwd', 'env ', 'printenv',
]

function isCommandAllowed(cmd: string): boolean {
  const t = cmd.trim()
  return ALLOWED_COMMAND_PREFIXES.some((p) => t.startsWith(p) || t === p.trim())
}

function safePath(workdir: string, relPath: string): string {
  const abs = resolve(workdir, relPath)
  if (!abs.startsWith(workdir)) throw new Error(`path traversal blocked: ${relPath}`)
  return abs
}

function toolReadFile(workdir: string, path: string): string {
  try {
    const abs = safePath(workdir, path)
    if (!existsSync(abs)) return `File not found: ${path}`
    return readFileSync(abs, 'utf-8')
  } catch (e) {
    return `Error reading file: ${String(e)}`
  }
}

function toolWriteFile(workdir: string, path: string, content: string): string {
  try {
    const abs = safePath(workdir, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    return `Written: ${path}`
  } catch (e) {
    return `Error writing file: ${String(e)}`
  }
}

function toolEditFile(workdir: string, path: string, oldString: string, newString: string): string {
  try {
    const abs = safePath(workdir, path)
    if (!existsSync(abs)) return `File not found: ${path}`
    const content = readFileSync(abs, 'utf-8')
    if (!content.includes(oldString)) return `old_string not found in ${path}`
    const updated = content.replace(oldString, newString)
    writeFileSync(abs, updated, 'utf-8')
    return `Edited: ${path}`
  } catch (e) {
    return `Error editing file: ${String(e)}`
  }
}

function toolRunCommand(workdir: string, command: string): string {
  if (!isCommandAllowed(command)) {
    return `Command not allowed. Allowed prefixes: ${ALLOWED_COMMAND_PREFIXES.slice(0, 8).join(', ')}...`
  }
  try {
    const output = execSync(command, {
      cwd: workdir,
      stdio: 'pipe',
      timeout: 60_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).toString()
    return output.slice(0, 4000) || '(no output)'
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const out = [e.stdout?.toString(), e.stderr?.toString(), e.message].filter(Boolean).join('\n')
    return `Exit non-zero:\n${out.slice(0, 4000)}`
  }
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace the first occurrence of old_string with new_string in a file. Fails if old_string is not found.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        old_string: { type: 'string', description: 'Exact string to replace' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace (restricted allowlist).',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'finish_task',
    description: 'Call this when all changes are complete.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of changes made' },
      },
      required: ['summary'],
    },
  },
]

async function addLog(taskId: number, level: string, message: string): Promise<void> {
  await db.insert(taskLogs).values({ task_id: taskId, level, message })
}

function executeTool(workdir: string, name: string, input: Record<string, string>): string {
  switch (name) {
    case 'read_file':
      return toolReadFile(workdir, input.path)
    case 'write_file':
      return toolWriteFile(workdir, input.path, input.content)
    case 'edit_file':
      return toolEditFile(workdir, input.path, input.old_string, input.new_string)
    case 'run_command':
      return toolRunCommand(workdir, input.command)
    case 'finish_task':
      return `DONE: ${input.summary}`
    default:
      return `Unknown tool: ${name}`
  }
}

function buildThinkingParam(level: string | undefined) {
  const budget = level === 'high' ? 16000 : level === 'medium' ? 8000 : level === 'low' ? 2048 : 0
  return budget > 0 ? { thinking: { type: 'enabled' as const, budget_tokens: budget } } : {}
}

export async function runCoderLoop(
  workdir: string,
  taskId: number,
  issueTitle: string,
  issueBody: string | null,
  planMd: string,
  filesToTouch: string[],
  modelId = 'claude-sonnet-4-6',
  thinkingLevel = 'low',
  fixNotes?: string,
): Promise<CoderResult> {
  const thinking = buildThinkingParam(thinkingLevel)
  const maxTokens = (thinking.thinking?.budget_tokens ?? 0) + 8192

  const systemPrompt = [
    'You are a coding agent implementing a GitHub issue. Use the provided tools to make the required changes.',
    'Read files before modifying them. Make all changes needed by the plan.',
    "When you have finished ALL changes, call finish_task with a brief summary. Don't stop before calling it.",
    '',
    `Working directory: ${workdir}`,
    filesToTouch.length > 0 ? `Files likely to touch: ${filesToTouch.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const userContent = [
    `## Issue: ${issueTitle}`,
    issueBody ?? '',
    '',
    '## Implementation plan',
    planMd,
    fixNotes ? `\n## Fix required\n${fixNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  type MsgContent = Anthropic.MessageParam['content']
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]

  let totalIn = 0
  let totalOut = 0
  let summary = 'done'
  const MAX_TURNS = 50

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: TOOLS,
      messages,
      ...thinking,
    })

    totalIn += response.usage.input_tokens
    totalOut += response.usage.output_tokens

    // Log text blocks from Claude
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        await addLog(taskId, 'claude', block.text.trim().slice(0, 2000))
      }
    }

    // Check for finish_task tool call
    const finishCall = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'finish_task',
    )
    if (finishCall) {
      summary = (finishCall.input as Record<string, string>).summary ?? 'done'
      await addLog(taskId, 'info', `Coder finished: ${summary}`)
      break
    }

    if (response.stop_reason === 'end_turn') break
    if (response.stop_reason !== 'tool_use') break

    // Execute tool calls and build tool result messages
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const input = block.input as Record<string, string>
      await addLog(taskId, 'cmd', `${block.name}(${JSON.stringify(input).slice(0, 300)})`)
      const result = executeTool(workdir, block.name, input)
      await addLog(taskId, 'cmd', `→ ${result.slice(0, 500)}`)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }

    messages.push({ role: 'assistant', content: response.content as MsgContent })
    messages.push({ role: 'user', content: toolResults })
  }

  log.info({ taskId, turns: messages.length / 2, totalIn, totalOut }, 'coder loop complete')

  return {
    summary,
    usage: { inputTokens: totalIn, outputTokens: totalOut, costUsd: estimateCost(modelId, totalIn, totalOut) },
  }
}
