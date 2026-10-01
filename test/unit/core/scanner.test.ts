import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { scan, writeJson } from '../../../src/core/scanner'
import { createMoviesModule } from '../../../src/media/movies'
import { defaultMoviesRules } from '../../../src/core/rules/movies'
import { WarningCollector } from '../../../src/core/types'

describe('writeJson', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-scanner-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('writes the serialized output for an empty records map', () => {
    const module = createMoviesModule({
      ...defaultMoviesRules,
      categories: [{ name: 'UHD' }],
    })
    const out = path.join(tmpDir, 'out.json')
    writeJson(new Map(), module, out)
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual([])
  })

  it('writes a list when the module returns serialized records', () => {
    const module = createMoviesModule({
      ...defaultMoviesRules,
      categories: [{ name: 'UHD' }],
    })
    const out = path.join(tmpDir, 'out.json')
    const records = new Map([
      [
        'k',
        {
          title: 'X',
          year: 2000,
          edition: null,
          tmdb_id: null,
          versions: [{ category: 'UHD', quality: null }],
        },
      ],
    ])
    writeJson(records, module, out)
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe('X')
  })

  it('logs the entry count after writing', () => {
    const module = createMoviesModule({
      ...defaultMoviesRules,
      categories: [{ name: 'UHD' }],
    })
    writeJson(new Map(), module, path.join(tmpDir, 'out.json'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/0 entries/))
  })
})

// writeWarnings tests live in test/unit/core/runner-shared.test.ts since
// the function moved out of scanner.ts as part of unifying the two near-
// identical implementations into one.

describe('scan — top-level integration', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-scan-int-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('logs [SKIP] for category folders that do not exist on disk', () => {
    const module = createMoviesModule({
      ...defaultMoviesRules,
      categories: [{ name: 'UHD' }, { name: 'HD' }],
    })
    const warnings = new WarningCollector()

    // Build only UHD; HD is missing on disk.
    fs.mkdirSync(path.join(tmpDir, 'UHD'))

    scan({ root_path: tmpDir }, module, warnings, new Map())

    const messages = logSpy.mock.calls.flat().join('\n')
    expect(messages).toMatch(/SKIP.*HD/)
  })

  it('logs the friendlier root_path message for the synthetic-default category', () => {
    const module = createMoviesModule({
      ...defaultMoviesRules,
      categories: [],
    })
    const warnings = new WarningCollector()

    scan({ root_path: tmpDir }, module, warnings, new Map())

    const messages = logSpy.mock.calls.flat().join('\n')
    expect(messages).toMatch(/no categories configured/)
  })
})
