import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { DirReader } from '../../../src/core/dir-reader'
import { scan } from '../../../src/core/scanner'
import { WarningCollector } from '../../../src/core/types'
import { defaultShowsRules, type ShowsRules } from '../../../src/core/rules/shows'
import { createShowsModule } from '../../../src/media/shows'
import { ProbeCache } from '../../../src/probe/cache'
import { probeShows } from '../../../src/probe/shows'
import { buildLibrary, cleanupLibrary } from '../../fixtures/library'

describe('DirReader', () => {
  let root: string

  afterEach(() => {
    vi.restoreAllMocks()
    if (root) cleanupLibrary(root)
  })

  it('lists a folder from disk once and hands back the same listing after', () => {
    root = buildLibrary({ a: { 'x.mkv': '' } })
    const readdir = vi.spyOn(fs, 'readdirSync')
    const dir = new DirReader()

    const first = dir.readdir(path.join(root, 'a'))
    const second = dir.readdir(path.join(root, 'a'))

    expect(first.map(e => e.name)).toEqual(['x.mkv'])
    expect(second).toBe(first)
    expect(readdir).toHaveBeenCalledTimes(1)
  })

  it('remembers a failed listing and throws it on every read', () => {
    root = buildLibrary({})
    const readdir = vi.spyOn(fs, 'readdirSync')
    const dir = new DirReader()
    const missing = path.join(root, 'nope')

    expect(() => dir.readdir(missing)).toThrow(/ENOENT/)
    expect(() => dir.readdir(missing)).toThrow(/ENOENT/)
    expect(readdir).toHaveBeenCalledTimes(1)
  })

  it('says whether a path is a folder', () => {
    root = buildLibrary({ a: { 'x.mkv': '' } })
    const dir = new DirReader()
    expect(dir.isDirectory(path.join(root, 'a'))).toBe(true)
    expect(dir.isDirectory(path.join(root, 'a', 'x.mkv'))).toBe(false)
    expect(dir.isDirectory(path.join(root, 'missing'))).toBe(false)
  })

  it('lets the probe and scan passes share one listing of every folder', async () => {
    root = buildLibrary({
      HD: {
        'Show (2020)': {
          'Season 01': { 'Show (2020) - S01E01.mkv': '', 'Show (2020) - S01E02.mkv': '' },
          'Season 02': { 'Show (2020) - S02E01.mkv': '' },
        },
        'Other (2019)': { 'Season 01': { 'Other (2019) - S01E01.mkv': '' } },
      },
    })
    const rules: ShowsRules = { ...defaultShowsRules, categories: [{ name: 'HD' }] }
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-dirreader-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const readdir = vi.spyOn(fs, 'readdirSync')
    const dir = new DirReader()
    const warnings = new WarningCollector()
    const cache = new ProbeCache(path.join(cacheDir, 'probe.json'))
    // ffprobe fails on the empty fixture files; that's fine — the walk is what's measured.
    const { byPath } = await probeShows({ root_path: root }, rules, cache, warnings, dir)
    scan({ root_path: root }, createShowsModule(rules), warnings, byPath, dir)

    const listed = readdir.mock.calls.map(call => String(call[0]))
    expect(listed).toHaveLength(new Set(listed).size)
    // The root (for warn_unlisted_folder), HD, two shows, three seasons.
    expect(listed).toHaveLength(7)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })
})

describe('scan — unreadable category folder', () => {
  it('reports permission_denied instead of crashing the run', () => {
    const root = buildLibrary({ HD: {} })
    const dir = new DirReader()
    vi.spyOn(dir, 'readdir').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnings = new WarningCollector()
    const rules: ShowsRules = { ...defaultShowsRules, categories: [{ name: 'HD' }] }

    const records = scan({ root_path: root }, createShowsModule(rules), warnings, new Map(), dir)

    expect(records.size).toBe(0)
    expect(warnings.all().map(w => [w.type, w.path])).toEqual([['permission_denied', 'HD']])
    vi.restoreAllMocks()
    cleanupLibrary(root)
  })
})
