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
          folder: 'X (2000)',
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

describe('scan — warn_unlisted_folder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-scan-unlisted-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function run(dirs: string[], rules: Partial<typeof defaultMoviesRules>) {
    for (const d of dirs) fs.mkdirSync(path.join(tmpDir, d))
    const module = createMoviesModule({ ...defaultMoviesRules, ...rules })
    const warnings = new WarningCollector(undefined, (rules.categories ?? []).length > 0)
    scan({ root_path: tmpDir }, module, warnings, new Map())
    return warnings.all().filter(w => w.type === 'warn_unlisted_folder')
  }

  it('names a top-level folder that is not a listed category', () => {
    const hits = run(['UHD', 'HD', 'Other SD', '#recycle', '.hidden'], {
      categories: [{ name: 'UHD' }, { name: 'hd' }],
    })
    expect(hits.map(w => w.path)).toEqual(['Other SD'])
    expect(hits[0]?.issue).toMatch(/nothing in it is scanned/)
  })

  it('in a flat library, flags only folders named like a category', () => {
    const hits = run(['HD', 'The Crow (1994)', 'Other UHD'], { categories: [] })
    expect(hits.map(w => w.path)).toEqual(['HD', 'Other UHD'])
    expect(hits[0]?.issue).toMatch(/no categories are configured/)
  })

  it('stays quiet when the toggle is off', () => {
    const hits = run(['Other SD'], {
      categories: [{ name: 'UHD' }],
      checks: { ...defaultMoviesRules.checks, warn_unlisted_folder: false },
    })
    expect(hits).toEqual([])
  })
})
