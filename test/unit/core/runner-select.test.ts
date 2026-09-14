import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  printRunSummary,
  rootPathAvailable,
  rootProblem,
  selectRoot,
  warningBreakdown,
} from '../../../src/core/runner-shared'
import { AppConfig, WarningCollector } from '../../../src/core/types'

const config: AppConfig = {
  movies: [
    { root_path: 'M:\\Movies', name: 'Server' },
    { root_path: 'D:\\Movies', name: 'External' },
  ],
  music: [{ root_path: 'M:\\Audio', name: 'Server' }],
}

describe('rootProblem', () => {
  it('is null when the type has a matching root', () => {
    expect(rootProblem(config, 'movies', undefined)).toBeNull()
    expect(rootProblem(config, 'movies', 'external')).toBeNull()
  })

  it('names the configured drives when the requested one is missing', () => {
    expect(rootProblem(config, 'music', 'external')).toBe(
      "no root named 'external' configured for music (have: Server)"
    )
  })

  it('says a type left out of config.json is not configured', () => {
    expect(rootProblem(config, 'shows', undefined)).toBe("shows isn't configured in config.json")
    expect(rootProblem(config, 'shows', 'server')).toBe("shows isn't configured in config.json")
  })
})

describe('selectRoot', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('returns the first root when no drive is named', () => {
    expect(selectRoot(config, 'movies', undefined, false)?.name).toBe('Server')
  })

  it('matches the drive name case-insensitively', () => {
    expect(selectRoot(config, 'movies', 'EXTERNAL', false)?.name).toBe('External')
  })

  it('skips with a note under --all', () => {
    expect(selectRoot(config, 'shows', undefined, true)).toBeNull()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[SKIP] shows'))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('exits on a single-type run, pointing at config.example.json for a missing type', () => {
    expect(() => selectRoot(config, 'shows', undefined, false)).toThrow('process.exit called')
    const text = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
    expect(text).toContain("shows isn't configured")
    expect(text).toContain('config.example.json')
  })

  it('exits on a single-type run with an unknown drive, without the config hint', () => {
    expect(() => selectRoot(config, 'music', 'external', false)).toThrow('process.exit called')
    const text = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
    expect(text).toContain("no root named 'external'")
    expect(text).not.toContain('config.example.json')
  })
})

describe('printRunSummary', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => logSpy.mockRestore())

  const lines = () => logSpy.mock.calls.map((call: unknown[]) => String(call[0]))

  it('prints totals, the breakdown, and where to look', () => {
    const warnings = new WarningCollector()
    warnings.add('warn_b', 'HD/B (2000)', 'b')
    warnings.add('warn_a', 'HD/A (2000)', 'a')
    warnings.add('warn_a', 'HD/C (2000)', 'c')

    printRunSummary(warnings, {
      noun: 'warnings',
      lead: '10 entries, ',
      tail: ' 3 TMDB requests.',
      review: 'output/server/movies/warnings.json',
    })

    expect(lines()).toEqual([
      '\n  Done — 10 entries, 3 warnings. 3 TMDB requests.',
      `    ${warningBreakdown(warnings)}`,
      '  → Review output/server/movies/warnings.json',
    ])
  })

  it('prints only the totals line when there is nothing to review', () => {
    printRunSummary(new WarningCollector(), { noun: 'validation warnings', review: 'x' })
    expect(lines()).toEqual(['\n  Done — 0 validation warnings.'])
  })
})

describe('rootPathAvailable', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-root-available-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('is true for an existing folder', () => {
    expect(rootPathAvailable('shows', { root_path: tmpDir, name: 'External' }, false)).toBe(true)
  })

  it('skips with a note under --all when the folder is missing', () => {
    const root = { root_path: path.join(tmpDir, 'Move'), name: 'External' }
    expect(rootPathAvailable('shows', root, true)).toBe(false)
    const text = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
    expect(text).toContain("[SKIP] shows root 'External' not found")
    expect(text).toContain('update root_path in config.json')
  })

  it('exits on a single-type run when the folder is missing', () => {
    const root = { root_path: path.join(tmpDir, 'Move'), name: 'External' }
    expect(() => rootPathAvailable('shows', root, false)).toThrow('process.exit called')
  })

  it('treats a file at root_path as missing', () => {
    const file = path.join(tmpDir, 'not-a-folder.txt')
    fs.writeFileSync(file, '')
    expect(rootPathAvailable('movies', { root_path: file, name: 'Server' }, true)).toBe(false)
  })
})
