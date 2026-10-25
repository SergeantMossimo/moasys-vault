import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod'

import { loadRules } from '../../../../src/core/rules/loader'

/**
 * Minimal schema used to exercise the loader behavior without coupling these
 * tests to per-media-type rule shapes. The loader is purely about merging
 * layers and resolving sentinels — the schema's only job here is to validate
 * the merged result.
 */
const TestSchema = z.object({
  flag: z.boolean(),
  name: z.string(),
  count: z.number(),
  year: z.union([z.number(), z.literal('current')]).optional(),
  items: z.array(z.string()).optional(),
  nested: z.object({ a: z.string(), b: z.string() }).optional(),
})

type TestRules = z.infer<typeof TestSchema>

const defaults: TestRules = {
  flag: true,
  name: 'default-name',
  count: 0,
}

describe('loadRules — three-tier merge', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-loader-'))
    fs.mkdirSync(path.join(tmpDir, 'rules'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function writeYaml(name: string, contents: string) {
    fs.writeFileSync(path.join(tmpDir, 'rules', name), contents, 'utf-8')
  }

  it('returns code defaults when neither YAML file exists', () => {
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules).toEqual(defaults)
  })

  it('logs that code defaults are in use when no YAML files exist', () => {
    loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    const messages = logSpy.mock.calls.flat().join('\n')
    expect(messages).toMatch(/Using code defaults/)
  })

  it('merges base YAML over code defaults', () => {
    writeYaml('test.yaml', 'name: from-yaml\ncount: 5\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules.name).toBe('from-yaml')
    expect(rules.count).toBe(5)
    expect(rules.flag).toBe(true) // default preserved
  })

  it('logs base YAML loaded message when only the base file exists', () => {
    writeYaml('test.yaml', 'count: 7\n')
    loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    const messages = logSpy.mock.calls.flat().join('\n')
    expect(messages).toMatch(/Loaded rules\/test\.yaml \(no local overrides\)/)
  })

  it('merges local YAML over base YAML', () => {
    writeYaml('test.yaml', 'name: from-base\ncount: 5\n')
    writeYaml('test.local.yaml', 'name: from-local\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules.name).toBe('from-local')
    expect(rules.count).toBe(5) // from base
    expect(rules.flag).toBe(true) // from defaults
  })

  it('logs the override count when local YAML exists', () => {
    writeYaml('test.yaml', '')
    writeYaml('test.local.yaml', 'name: local-only\ncount: 9\n')
    loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    const messages = logSpy.mock.calls.flat().join('\n')
    expect(messages).toMatch(/2 override\(s\) from rules\/test\.local\.yaml/)
  })

  it('replaces arrays wholesale instead of concatenating', () => {
    writeYaml('test.yaml', 'name: x\ncount: 0\nitems: [a, b, c]\n')
    writeYaml('test.local.yaml', 'items: [x, y]\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules.items).toEqual(['x', 'y'])
  })

  it('deep-merges nested objects key by key', () => {
    writeYaml('test.yaml', 'name: x\ncount: 0\nnested: { a: from-base, b: from-base }\n')
    writeYaml('test.local.yaml', 'nested: { a: from-local }\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules.nested).toEqual({ a: 'from-local', b: 'from-base' })
  })

  it('resolves the "current" sentinel to the current year', () => {
    // A fixed clock, so the test can't straddle midnight on New Year's Eve.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-06-15T12:00:00Z'))
    writeYaml('test.yaml', 'name: x\ncount: 0\nyear: current\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    vi.useRealTimers()
    expect(rules.year).toBe(2031)
  })

  it('resolves sentinels nested deep in the rules tree', () => {
    const deepSchema = z.object({
      band: z.object({ to: z.union([z.number(), z.literal('current')]) }),
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-06-15T12:00:00Z'))
    writeYaml('deep.yaml', 'band: { to: current }\n')
    const rules = loadRules({
      mediaType: 'deep',
      schema: deepSchema,
      defaults: { band: { to: 1900 } },
      projectRoot: tmpDir,
    })
    vi.useRealTimers()
    expect(rules.band.to).toBe(2031)
  })

  it('treats a comments-only YAML as no overrides', () => {
    writeYaml('test.yaml', '# this is all comments\n# another comment\n')
    const rules = loadRules({
      mediaType: 'test',
      schema: TestSchema,
      defaults,
      projectRoot: tmpDir,
    })
    expect(rules).toEqual(defaults)
  })
})

describe('loadRules — error handling', () => {
  let tmpDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-loader-err-'))
    fs.mkdirSync(path.join(tmpDir, 'rules'))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    exitSpy.mockRestore()
    errorSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('exits when YAML is malformed', () => {
    fs.writeFileSync(path.join(tmpDir, 'rules', 'test.yaml'), 'name: [unterminated\n', 'utf-8')
    expect(() =>
      loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    ).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/Error parsing/)
  })

  it('exits when the merged result fails schema validation', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'rules', 'test.yaml'),
      'name: 42\ncount: not-a-number\n',
      'utf-8'
    )
    expect(() =>
      loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    ).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/failed schema validation/)
  })

  it('reports each validation issue with its path', () => {
    fs.writeFileSync(path.join(tmpDir, 'rules', 'test.yaml'), 'count: bad\nname: 1\n', 'utf-8')
    expect(() =>
      loadRules({ mediaType: 'test', schema: TestSchema, defaults, projectRoot: tmpDir })
    ).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/count/)
    expect(output).toMatch(/name/)
  })
})
