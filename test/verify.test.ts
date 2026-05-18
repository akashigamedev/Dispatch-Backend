import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNightowlConfig, autoDetectSteps } from '../src/worker/verify.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nw-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadNightowlConfig', () => {
  it('returns empty object when no .nightowl.yml exists', () => {
    expect(loadNightowlConfig(dir)).toEqual({})
  })

  it('parses a full .nightowl.yml', () => {
    writeFileSync(join(dir, '.nightowl.yml'), `
base_branch: main
branch_prefix: bot/
max_diff_lines: 500
paths_off_limits:
  - "infra/**"
  - "**/*.lock"
verify:
  - name: install
    run: pnpm install --frozen-lockfile
    required: true
  - name: test
    run: pnpm test
    required: false
`)
    const cfg = loadNightowlConfig(dir)
    expect(cfg.base_branch).toBe('main')
    expect(cfg.branch_prefix).toBe('bot/')
    expect(cfg.max_diff_lines).toBe(500)
    expect(cfg.paths_off_limits).toEqual(['infra/**', '**/*.lock'])
    expect(cfg.verify).toHaveLength(2)
    expect(cfg.verify![0]).toEqual({ name: 'install', run: 'pnpm install --frozen-lockfile', required: true })
    expect(cfg.verify![1]).toEqual({ name: 'test', run: 'pnpm test', required: false })
  })

  it('returns empty object on malformed YAML', () => {
    writeFileSync(join(dir, '.nightowl.yml'), '{ invalid yaml: [')
    expect(loadNightowlConfig(dir)).toEqual({})
  })

  it('ignores unknown fields', () => {
    writeFileSync(join(dir, '.nightowl.yml'), 'unknown_field: 42\nbase_branch: dev')
    expect(loadNightowlConfig(dir).base_branch).toBe('dev')
  })
})

describe('autoDetectSteps', () => {
  it('returns empty array when no marker files present', () => {
    expect(autoDetectSteps(dir)).toEqual([])
  })

  it('detects pnpm project with test script', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }))
    const steps = autoDetectSteps(dir)
    expect(steps.find((s) => s.name === 'install')?.run).toBe('pnpm install --frozen-lockfile')
    expect(steps.find((s) => s.name === 'lint')?.run).toBe('pnpm lint')
    expect(steps.find((s) => s.name === 'test')?.run).toBe('pnpm test')
  })

  it('detects pnpm project without test script', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }))
    const steps = autoDetectSteps(dir)
    expect(steps.find((s) => s.name === 'install')).toBeDefined()
    expect(steps.find((s) => s.name === 'test')).toBeUndefined()
  })

  it('detects npm project', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
    const steps = autoDetectSteps(dir)
    expect(steps.find((s) => s.name === 'install')?.run).toBe('npm ci')
    expect(steps.find((s) => s.name === 'test')?.run).toBe('npm test')
  })

  it('detects Go project', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\ngo 1.21')
    const steps = autoDetectSteps(dir)
    expect(steps.find((s) => s.name === 'build')?.run).toBe('go build ./...')
    expect(steps.find((s) => s.name === 'test')?.run).toBe('go test ./...')
  })

  it('detects Cargo project', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"')
    const steps = autoDetectSteps(dir)
    expect(steps.find((s) => s.name === 'check')?.run).toBe('cargo check')
    expect(steps.find((s) => s.name === 'test')?.run).toBe('cargo test')
  })
})
