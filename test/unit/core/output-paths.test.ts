import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  findLegacyOutputFiles,
  reportLegacyOutputFiles,
  typeOutputPaths,
} from '../../../src/core/output-paths'

describe('typeOutputPaths', () => {
  const root = path.join(os.tmpdir(), 'project')
  const out = typeOutputPaths(root, 'server', 'shows')

  it('keeps the catalog and warnings files at the top of the type folder', () => {
    const dir = path.join(root, 'output', 'server', 'shows')
    expect(out.dir).toBe(dir)
    expect(out.catalog).toBe(path.join(dir, 'shows.json'))
    expect(out.warnings).toBe(path.join(dir, 'warnings.json'))
    expect(out.validationWarnings).toBe(path.join(dir, 'validation-warnings.json'))
    expect(out.plexWarnings).toBe(path.join(dir, 'plex-warnings.json'))
    expect(out.plexLogWarnings).toBe(path.join(dir, 'plex-log-warnings.json'))
    expect(out.allWarnings).toBe(path.join(dir, 'all-warnings.json'))
  })

  it('puts probe and validation data under data/', () => {
    expect(out.probe).toBe(path.join(out.dir, 'data', 'probe.json'))
    expect(out.validation).toBe(path.join(out.dir, 'data', 'validation.json'))
  })

  it('puts --no-ignore files in their own subfolder', () => {
    expect(out.unfilteredDir).toBe(path.join(out.dir, 'unfiltered'))
  })

  it('gives a forward-slash display path relative to the project root', () => {
    expect(out.displayDir).toBe('output/server/shows')
  })
})

describe('legacy output files', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-output-paths-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function touch(...names: string[]) {
    const out = typeOutputPaths(tmpDir, 'server', 'shows')
    fs.mkdirSync(path.join(out.dir, 'data'), { recursive: true })
    for (const name of names) fs.writeFileSync(path.join(out.dir, name), '{}')
    return out
  }

  it('finds files the old flat layout left at the top level', () => {
    const out = touch(
      'probe.json',
      'validation.json',
      'rename-plan.json',
      'rename-undo-2026-09-07T21-57-53-887Z.json',
      'plex-warnings.unfiltered.json'
    )
    expect(findLegacyOutputFiles(out.dir)).toEqual([
      'plex-warnings.unfiltered.json',
      'probe.json',
      'rename-plan.json',
      'rename-undo-2026-09-07T21-57-53-887Z.json',
      'validation.json',
    ])
  })

  it('ignores current files and anything inside the subfolders', () => {
    const out = touch(
      'shows.json',
      'warnings.json',
      'validation-warnings.json',
      'plex-warnings.json'
    )
    fs.writeFileSync(out.probe, '{}')
    expect(findLegacyOutputFiles(out.dir)).toEqual([])
  })

  it('returns nothing for a folder that does not exist yet', () => {
    expect(findLegacyOutputFiles(path.join(tmpDir, 'missing'))).toEqual([])
  })

  it('reports once per folder and never deletes anything', () => {
    const out = touch('probe.json')
    reportLegacyOutputFiles(out)
    reportLegacyOutputFiles(out)

    const notes = logSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('[NOTE]'))
    expect(notes).toHaveLength(1)
    expect(String(notes[0]?.[0])).toContain('probe.json')
    expect(fs.existsSync(path.join(out.dir, 'probe.json'))).toBe(true)
  })

  it('lists the removed fix:shows folder but not the current subfolders', () => {
    const out = touch()
    fs.mkdirSync(path.join(out.dir, 'fixes'))
    fs.mkdirSync(out.unfilteredDir)
    expect(findLegacyOutputFiles(out.dir)).toEqual(['fixes/'])
  })

  it('points undo manifests at the last version that can replay them', () => {
    const out = touch('rename-undo-2026-01-01T00-00-00-000Z.json')
    reportLegacyOutputFiles(out)
    const text = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
    expect(text).toContain('fix:shows was removed')
    expect(text).toContain('8e7515a')
  })
})
