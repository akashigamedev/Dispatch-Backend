import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const verifyStepSchema = z.object({
  name: z.string(),
  run: z.string(),
  required: z.boolean().default(true),
})

const dispatchConfigSchema = z.object({
  base_branch: z.string().optional(),
  branch_prefix: z.string().optional(),
  paths_off_limits: z.array(z.string()).optional(),
  verify: z.array(verifyStepSchema).optional(),
  max_diff_lines: z.number().optional(),
})

export type DispatchConfig = z.infer<typeof dispatchConfigSchema>
export type VerifyStep = z.infer<typeof verifyStepSchema>

export interface VerifyStepResult {
  name: string
  passed: boolean
  required: boolean
  output: string
}

export interface VerifyResult {
  passed: boolean
  steps: VerifyStepResult[]
  failedStep?: VerifyStep & { output: string }
}

export function loadDispatchConfig(workdir: string): DispatchConfig {
  const configPath = join(workdir, '.dispatch.yml')
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = parseYaml(raw)
    return dispatchConfigSchema.parse(parsed)
  } catch {
    return {}
  }
}

export function autoDetectSteps(workdir: string): VerifyStep[] {
  if (existsSync(join(workdir, 'pnpm-lock.yaml'))) {
    const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf-8'))
    const steps: VerifyStep[] = [{ name: 'install', run: 'pnpm install --frozen-lockfile', required: true }]
    if (pkg.scripts?.lint) steps.push({ name: 'lint', run: 'pnpm lint', required: true })
    if (pkg.scripts?.typecheck) steps.push({ name: 'typecheck', run: 'pnpm typecheck', required: false })
    if (pkg.scripts?.test) steps.push({ name: 'test', run: 'pnpm test', required: true })
    return steps
  }
  if (existsSync(join(workdir, 'package-lock.json'))) {
    const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf-8'))
    const steps: VerifyStep[] = [{ name: 'install', run: 'npm ci', required: true }]
    if (pkg.scripts?.test) steps.push({ name: 'test', run: 'npm test', required: true })
    return steps
  }
  if (existsSync(join(workdir, 'pyproject.toml'))) {
    const content = readFileSync(join(workdir, 'pyproject.toml'), 'utf-8')
    if (content.includes('[tool.poetry]')) {
      return [
        { name: 'install', run: 'poetry install', required: true },
        { name: 'test', run: 'poetry run pytest -x', required: true },
      ]
    }
  }
  if (existsSync(join(workdir, 'go.mod'))) {
    return [{ name: 'build', run: 'go build ./...', required: true }, { name: 'test', run: 'go test ./...', required: true }]
  }
  if (existsSync(join(workdir, 'Cargo.toml'))) {
    return [{ name: 'check', run: 'cargo check', required: true }, { name: 'test', run: 'cargo test', required: false }]
  }
  return []
}

export function runVerifyStep(workdir: string, step: VerifyStep): VerifyStepResult {
  const result = spawnSync(step.run, {
    shell: true,
    cwd: workdir,
    encoding: 'utf-8',
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status === 137) throw new Error('ran out of memory — needs bigger runner')
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  const passed = result.status === 0 && !result.error
  return { name: step.name, passed, required: step.required, output }
}

export function runAllVerifySteps(workdir: string, config: DispatchConfig): VerifyResult {
  const steps = config.verify ?? autoDetectSteps(workdir)
  if (steps.length === 0) {
    return { passed: true, steps: [] }
  }

  const results: VerifyStepResult[] = []
  for (const step of steps) {
    const result = runVerifyStep(workdir, step)
    results.push(result)
    if (!result.passed && result.required) {
      return {
        passed: false,
        steps: results,
        failedStep: { ...step, output: result.output.split('\n').slice(-200).join('\n') },
      }
    }
  }
  return { passed: true, steps: results }
}
