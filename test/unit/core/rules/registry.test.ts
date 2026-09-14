import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { loadTypeRules } from '../../../../src/core/rules/registry'
import { defaultMusicRules } from '../../../../src/core/rules/music'
import { defaultPlexRules } from '../../../../src/core/rules/plex'

describe('loadTypeRules', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-registry-'))
    fs.mkdirSync(path.join(tmpDir, 'rules'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('loads each type with its own schema and defaults', () => {
    expect(loadTypeRules('music', tmpDir)).toEqual(defaultMusicRules)
    expect(loadTypeRules('plex', tmpDir)).toEqual(defaultPlexRules)
  })

  it('applies the rules YAML layers', () => {
    fs.writeFileSync(path.join(tmpDir, 'rules', 'shows.local.yaml'), 'episode_code_case: lower\n')
    expect(loadTypeRules('shows', tmpDir).episode_code_case).toBe('lower')
  })

  it('loads a type once per project root and logs once', () => {
    const first = loadTypeRules('audiobooks', tmpDir)
    const second = loadTypeRules('audiobooks', tmpDir)
    expect(second).toBe(first)
    const rulesLines = logSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('[RULES]')
    )
    expect(rulesLines).toHaveLength(1)
  })
})
