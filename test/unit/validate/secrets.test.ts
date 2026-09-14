import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { SecretsSchema, hasSecrets, loadSecrets } from '../../../src/validate/secrets'

const validKey = 'abc1234567890123456789' // 22 chars, passes min(20)
const validToken = 'xYz123AbC456dEf' // passes min(10)

describe('SecretsSchema', () => {
  it('accepts a valid TMDB key', () => {
    expect(SecretsSchema.safeParse({ tmdb: { api_key: validKey } }).success).toBe(true)
  })

  it('accepts a valid Plex token', () => {
    expect(SecretsSchema.safeParse({ plex: { token: validToken } }).success).toBe(true)
  })

  it('accepts an optional _notes block', () => {
    expect(
      SecretsSchema.safeParse({
        _notes: { reminder: 'rotate this key annually' },
        tmdb: { api_key: validKey },
      }).success
    ).toBe(true)
  })

  it('accepts a file with no integration blocks — each command checks its own', () => {
    expect(SecretsSchema.safeParse({}).success).toBe(true)
  })

  it('rejects when api_key is too short', () => {
    expect(SecretsSchema.safeParse({ tmdb: { api_key: 'short' } }).success).toBe(false)
  })

  it('rejects the .secrets.json.example placeholder strings', () => {
    const tmdb = SecretsSchema.safeParse({ tmdb: { api_key: 'PASTE-YOUR-TMDB-V3-API-KEY-HERE' } })
    expect(tmdb.success).toBe(false)
    if (!tmdb.success) expect(tmdb.error.issues[0]?.message).toMatch(/placeholder/i)

    const plex = SecretsSchema.safeParse({ plex: { token: 'PASTE-YOUR-PLEX-TOKEN-HERE' } })
    expect(plex.success).toBe(false)
  })

  it('rejects when api_key is the wrong type', () => {
    expect(SecretsSchema.safeParse({ tmdb: { api_key: 42 } }).success).toBe(false)
  })
})

describe('loadSecrets', () => {
  let tmpDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  const write = (content: unknown) =>
    fs.writeFileSync(
      path.join(tmpDir, '.secrets.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf-8'
    )

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-secrets-'))
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

  it('returns the requested TMDB block', () => {
    write({ tmdb: { api_key: validKey } })
    expect(loadSecrets(tmpDir, 'tmdb').api_key).toBe(validKey)
  })

  it('returns the requested Plex block', () => {
    write({ plex: { token: validToken } })
    expect(loadSecrets(tmpDir, 'plex').token).toBe(validToken)
  })

  it('ignores an invalid block for a different integration', () => {
    write({ tmdb: { api_key: 'PASTE-YOUR-TMDB-V3-API-KEY-HERE' }, plex: { token: validToken } })
    expect(loadSecrets(tmpDir, 'plex').token).toBe(validToken)
  })

  it('exits with setup hints when .secrets.json is missing', () => {
    expect(() => loadSecrets(tmpDir, 'tmdb')).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/\.secrets\.json not found/)
    expect(output).toMatch(/themoviedb\.org/)
  })

  it('exits naming the missing block and how to get the credential', () => {
    write({ tmdb: { api_key: validKey } })
    expect(() => loadSecrets(tmpDir, 'plex')).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/no "plex" block/)
    expect(output).toMatch(/X-Plex-Token/)
  })

  it('exits with parse error message when JSON is malformed', () => {
    write('{ not json')
    expect(() => loadSecrets(tmpDir, 'tmdb')).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Error parsing/))
  })

  it('exits with a schema message naming the field when the block is invalid', () => {
    write({ tmdb: { api_key: 'short' } })
    expect(() => loadSecrets(tmpDir, 'tmdb')).toThrow('process.exit called')
    const output = errorSpy.mock.calls.flat().join('\n')
    expect(output).toMatch(/failed schema validation/)
    expect(output).toMatch(/tmdb\.api_key/)
  })
})

describe('hasSecrets', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-has-secrets-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const write = (contents: string) => fs.writeFileSync(path.join(tmpDir, '.secrets.json'), contents)

  it('is false when .secrets.json does not exist', () => {
    expect(hasSecrets(tmpDir, 'tmdb')).toBe(false)
  })

  it('is false for malformed JSON, without printing or exiting', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    write('{ nope')
    expect(hasSecrets(tmpDir, 'tmdb')).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('is false when the block is missing or still the example placeholder', () => {
    write(JSON.stringify({ plex: { token: 'abcdefghijklmnop' } }))
    expect(hasSecrets(tmpDir, 'tmdb')).toBe(false)
    write(JSON.stringify({ tmdb: { api_key: 'PASTE-YOUR-TMDB-V3-API-KEY-HERE' } }))
    expect(hasSecrets(tmpDir, 'tmdb')).toBe(false)
  })

  it('is true for a valid block, independent of other blocks', () => {
    write(
      JSON.stringify({
        tmdb: { api_key: '0123456789abcdef0123456789abcdef' },
        plex: { token: 'PASTE-YOUR-PLEX-TOKEN-HERE' },
      })
    )
    expect(hasSecrets(tmpDir, 'tmdb')).toBe(true)
    expect(hasSecrets(tmpDir, 'plex')).toBe(false)
  })
})
