import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { AppConfigSchema, driveSlug, loadConfig } from '../../../src/core/config'

describe('AppConfigSchema', () => {
  const validConfig = {
    movies: [{ root_path: 'M:\\Movies', name: 'Server' }],
    shows: [{ root_path: 'M:\\Shows', name: 'Server' }],
    music: [{ root_path: 'M:\\Audio', name: 'Server' }],
    audiobooks: [{ root_path: 'M:\\Audiobooks', name: 'Server' }],
  }

  it('accepts the minimal valid shape', () => {
    expect(AppConfigSchema.safeParse(validConfig).success).toBe(true)
  })

  it('accepts several named roots for one media type', () => {
    const multi = {
      ...validConfig,
      movies: [
        { root_path: 'M:\\Movies', name: 'Server' },
        { root_path: 'D:\\Movies', name: 'External' },
      ],
    }
    expect(AppConfigSchema.safeParse(multi).success).toBe(true)
  })

  it('preserves root order (the first entry is the default)', () => {
    const multi = {
      ...validConfig,
      movies: [
        { root_path: 'D:\\Movies', name: 'External' },
        { root_path: 'M:\\Movies', name: 'Server' },
      ],
    }
    const result = AppConfigSchema.safeParse(multi)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.movies.map(r => r.name)).toEqual(['External', 'Server'])
    }
  })

  it('accepts an optional _notes object of string values', () => {
    expect(
      AppConfigSchema.safeParse({
        ...validConfig,
        _notes: { reminder: 'Update root_path when drive letter changes' },
      }).success
    ).toBe(true)
  })

  it('rejects when movies is missing', () => {
    const { movies: _movies, ...rest } = validConfig
    const result = AppConfigSchema.safeParse(rest)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('movies'))).toBe(true)
    }
  })

  it('rejects when shows is missing', () => {
    const { shows: _shows, ...rest } = validConfig
    expect(AppConfigSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects when music is missing', () => {
    const { music: _music, ...rest } = validConfig
    expect(AppConfigSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects when audiobooks is missing', () => {
    const { audiobooks: _audiobooks, ...rest } = validConfig
    expect(AppConfigSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty root list', () => {
    const bad = { ...validConfig, movies: [] }
    const result = AppConfigSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one root/i)
    }
  })

  it('rejects when root_path is an empty string', () => {
    const bad = { ...validConfig, movies: [{ root_path: '', name: 'Server' }] }
    const result = AppConfigSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/non-empty/i)
    }
  })

  it('rejects when root_path is the wrong type', () => {
    const bad = { ...validConfig, movies: [{ root_path: 42, name: 'Server' }] }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a root with no name', () => {
    const bad = { ...validConfig, movies: [{ root_path: 'M:\\Movies' }] }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a name containing path separators', () => {
    const bad = { ...validConfig, movies: [{ root_path: 'M:\\Movies', name: 'a/b' }] }
    const result = AppConfigSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/folder name/i)
    }
  })

  it('rejects a name containing a colon or backslash', () => {
    for (const name of ['C:', 'a\\b', 'a/b']) {
      const bad = { ...validConfig, movies: [{ root_path: 'M:\\Movies', name }] }
      expect(AppConfigSchema.safeParse(bad).success).toBe(false)
    }
  })

  it("rejects '.' and '..' as names (they would relocate the output folder)", () => {
    for (const name of ['.', '..']) {
      const bad = { ...validConfig, movies: [{ root_path: 'M:\\Movies', name }] }
      const result = AppConfigSchema.safeParse(bad)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/cannot be/i)
      }
    }
  })

  it("rejects 'plex' as a name in any case (output/plex/ is reserved)", () => {
    for (const name of ['plex', 'Plex', 'PLEX']) {
      const bad = { ...validConfig, movies: [{ root_path: 'M:\\Movies', name }] }
      const result = AppConfigSchema.safeParse(bad)
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.message).toMatch(/reserved/)
    }
  })

  it('accepts an optional plex block', () => {
    const ok = {
      ...validConfig,
      plex: {
        url: 'http://192.168.1.50:32400',
        path_map: [{ plex: '/volume1/Media', local: 'M:\\' }],
      },
    }
    expect(AppConfigSchema.safeParse(ok).success).toBe(true)
  })

  it('rejects a plex url that is not http(s)', () => {
    for (const url of ['192.168.1.50:32400', 'ftp://nas:32400']) {
      const bad = { ...validConfig, plex: { url } }
      expect(AppConfigSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('still allows dots inside a name', () => {
    const ok = { ...validConfig, movies: [{ root_path: 'M:\\Movies', name: 'NAS.2' }] }
    expect(AppConfigSchema.safeParse(ok).success).toBe(true)
  })

  it('rejects duplicate names within one media type', () => {
    const bad = {
      ...validConfig,
      movies: [
        { root_path: 'M:\\Movies', name: 'Server' },
        { root_path: 'D:\\Movies', name: 'Server' },
      ],
    }
    const result = AppConfigSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/duplicate name/i)
    }
  })

  it('treats names differing only by case as duplicates (folders collide on Windows)', () => {
    const bad = {
      ...validConfig,
      movies: [
        { root_path: 'M:\\Movies', name: 'Server' },
        { root_path: 'D:\\Movies', name: 'server' },
      ],
    }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('allows the same name across different media types', () => {
    // "Server" holding both movies and music is the normal case.
    expect(AppConfigSchema.safeParse(validConfig).success).toBe(true)
  })

  it('rejects when a media type is not an array', () => {
    const bad = { ...validConfig, movies: { root_path: 'M:\\Movies', name: 'Server' } }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects _notes that contains non-string values', () => {
    const bad = { ...validConfig, _notes: { reminder: 42 } }
    expect(AppConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('driveSlug', () => {
  it('lowercases the configured name', () => {
    expect(driveSlug('Server')).toBe('server')
    expect(driveSlug('External')).toBe('external')
  })

  it('is idempotent', () => {
    expect(driveSlug(driveSlug('Server'))).toBe('server')
  })
})

describe('loadConfig', () => {
  let tmpDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  const writeConfig = (value: unknown) =>
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(value), 'utf-8')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-config-'))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('loads and validates a valid config.json', () => {
    writeConfig({
      movies: [
        { root_path: 'M:\\Movies', name: 'Server' },
        { root_path: 'D:\\Movies', name: 'External' },
      ],
      shows: [{ root_path: 'M:\\Shows', name: 'Server' }],
      music: [{ root_path: 'M:\\Audio', name: 'Server' }],
      audiobooks: [{ root_path: 'M:\\Audiobooks', name: 'Server' }],
    })

    const loaded = loadConfig(tmpDir)
    expect(loaded.movies).toHaveLength(2)
    expect(loaded.movies[0]?.root_path).toBe('M:\\Movies')
    expect(loaded.movies[1]?.name).toBe('External')
    expect(loaded.audiobooks[0]?.root_path).toBe('M:\\Audiobooks')
  })

  it('exits with a helpful message when config.json is missing', () => {
    expect(() => loadConfig(tmpDir)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/config\.json not found/))
  })

  it('exits when config.json is malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ this is not json', 'utf-8')
    expect(() => loadConfig(tmpDir)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Error parsing config\.json/))
  })

  it('exits with a migration message on the old single-root shape', () => {
    writeConfig({
      movies: { root_path: 'M:\\Movies' },
      shows: { root_path: 'M:\\Shows' },
      music: { root_path: 'M:\\Audio' },
      audiobooks: { root_path: 'M:\\Audiobooks' },
    })
    expect(() => loadConfig(tmpDir)).toThrow('process.exit called')
    const allErrorOutput = errorSpy.mock.calls.flat().join('\n')
    expect(allErrorOutput).toMatch(/old single-root format/i)
    expect(allErrorOutput).toMatch(/LIST of named roots/i)
    expect(allErrorOutput).toMatch(/movies, shows, music, audiobooks/)
  })

  it('exits when config.json passes JSON.parse but fails schema validation', () => {
    writeConfig({ movies: [{ root_path: '', name: 'Server' }] })
    expect(() => loadConfig(tmpDir)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/failed schema validation/))
  })

  it('lists each validation issue path on failure', () => {
    writeConfig({ movies: [{ root_path: '', name: 'Server' }] })
    expect(() => loadConfig(tmpDir)).toThrow('process.exit called')
    // Each issue prints a line; one of them should reference movies.root_path or shows etc.
    const allErrorOutput = errorSpy.mock.calls.flat().join('\n')
    expect(allErrorOutput).toMatch(/root_path|shows|music|audiobooks/)
  })

  it('returns the original _notes when present (passes through validation)', () => {
    writeConfig({
      _notes: { hint: 'whatever' },
      movies: [{ root_path: 'M:\\Movies', name: 'Server' }],
      shows: [{ root_path: 'M:\\Shows', name: 'Server' }],
      music: [{ root_path: 'M:\\Audio', name: 'Server' }],
      audiobooks: [{ root_path: 'M:\\Audiobooks', name: 'Server' }],
    })
    const loaded = loadConfig(tmpDir)
    expect(loaded._notes).toEqual({ hint: 'whatever' })
  })
})
