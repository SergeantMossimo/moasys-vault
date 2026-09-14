import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { JsonCache, searchKey } from '../../../src/validate/cache'

interface SampleEntry {
  id: number
  name: string
}

describe('JsonCache', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-valcache-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('starts empty when the file does not exist', () => {
    const cache = new JsonCache<SampleEntry>(path.join(tmpDir, 'cache.json'))
    expect(cache.size()).toBe(0)
  })

  it('round-trips entries through set + get', () => {
    const cache = new JsonCache<SampleEntry>(path.join(tmpDir, 'cache.json'))
    cache.set('key', { id: 42, name: 'X' })
    expect(cache.get('key')).toEqual({ id: 42, name: 'X' })
    expect(cache.has('key')).toBe(true)
  })

  it('returns undefined for unknown keys', () => {
    const cache = new JsonCache<SampleEntry>(path.join(tmpDir, 'cache.json'))
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.has('missing')).toBe(false)
  })

  it('persists across save + reload', () => {
    const file = path.join(tmpDir, 'cache.json')

    const writer = new JsonCache<SampleEntry>(file)
    writer.set('a', { id: 1, name: 'A' })
    writer.set('b', { id: 2, name: 'B' })
    writer.save()

    const reader = new JsonCache<SampleEntry>(file)
    expect(reader.size()).toBe(2)
    expect(reader.get('a')).toEqual({ id: 1, name: 'A' })
  })

  it('applies normalize to loaded entries and keeps their fetched_at', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          a: {
            value: { id: 1, name: 'A', bulky: 'x'.repeat(100) },
            fetched_at: '2020-01-01T00:00:00Z',
          },
        },
      })
    )

    const cache = new JsonCache<SampleEntry>(file, 1, v => ({ id: v.id, name: v.name }))
    expect(cache.get('a')).toEqual({ id: 1, name: 'A' })

    // Old timestamp survives, so a slimmed entry still ages out on schedule.
    expect(cache.pruneOlderThan(1)).toBe(1)
  })

  it('discards cache when version mismatches', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 99, entries: { a: { id: 1, name: 'A' } } }),
      'utf-8'
    )

    const cache = new JsonCache<SampleEntry>(file, 1)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Version mismatch/))
  })

  it('discards cache when shape is unexpected', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(file, JSON.stringify({ totally: 'wrong' }), 'utf-8')

    const cache = new JsonCache<SampleEntry>(file)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Unexpected shape/))
  })

  it('discards cache when JSON is malformed', () => {
    const file = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(file, '{ not json', 'utf-8')

    const cache = new JsonCache<SampleEntry>(file)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Corrupt cache/))
  })

  it('sorts entries alphabetically on save', () => {
    const file = path.join(tmpDir, 'cache.json')
    const cache = new JsonCache<SampleEntry>(file)
    cache.set('c', { id: 3, name: 'C' })
    cache.set('a', { id: 1, name: 'A' })
    cache.set('b', { id: 2, name: 'B' })
    cache.save()

    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(Object.keys(written.entries)).toEqual(['a', 'b', 'c'])
  })

  it('creates parent directories on save if missing', () => {
    const file = path.join(tmpDir, 'nested', 'sub', 'cache.json')
    const cache = new JsonCache<SampleEntry>(file)
    cache.set('a', { id: 1, name: 'A' })
    cache.save()
    expect(fs.existsSync(file)).toBe(true)
  })

  it('respects the explicit version parameter', () => {
    const file = path.join(tmpDir, 'cache.json')
    const cache = new JsonCache<SampleEntry>(file, 5)
    cache.set('a', { id: 1, name: 'A' })
    cache.save()

    const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(written.version).toBe(5)
  })

  describe('timestamped entries + pruneOlderThan', () => {
    it('stamps each entry with an ISO 8601 fetched_at on set', () => {
      const file = path.join(tmpDir, 'cache.json')
      const cache = new JsonCache<SampleEntry>(file)
      cache.set('a', { id: 1, name: 'A' })
      cache.save()

      const written = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(written.entries.a).toHaveProperty('value')
      expect(written.entries.a).toHaveProperty('fetched_at')
      expect(written.entries.a.value).toEqual({ id: 1, name: 'A' })
      expect(written.entries.a.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('hides fetched_at from get() — returns just the value', () => {
      const file = path.join(tmpDir, 'cache.json')
      const cache = new JsonCache<SampleEntry>(file)
      cache.set('a', { id: 1, name: 'A' })
      expect(cache.get('a')).toEqual({ id: 1, name: 'A' })
    })

    it('persists timestamps across save + reload', () => {
      const file = path.join(tmpDir, 'cache.json')
      const writer = new JsonCache<SampleEntry>(file)
      writer.set('a', { id: 1, name: 'A' })
      writer.save()

      const reader = new JsonCache<SampleEntry>(file)
      expect(reader.get('a')).toEqual({ id: 1, name: 'A' })
    })

    it('pruneOlderThan(0) is a no-op', () => {
      const cache = new JsonCache<SampleEntry>(path.join(tmpDir, 'cache.json'))
      cache.set('a', { id: 1, name: 'A' })
      cache.set('b', { id: 2, name: 'B' })
      expect(cache.pruneOlderThan(0)).toBe(0)
      expect(cache.size()).toBe(2)
    })

    it('pruneOlderThan removes entries older than N days, keeps fresh ones', () => {
      const file = path.join(tmpDir, 'cache.json')
      const oldTimestamp = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            old: { value: { id: 1, name: 'old' }, fetched_at: oldTimestamp },
            fresh: { value: { id: 2, name: 'fresh' }, fetched_at: new Date().toISOString() },
          },
        }),
        'utf-8'
      )

      const cache = new JsonCache<SampleEntry>(file)
      expect(cache.size()).toBe(2)
      expect(cache.pruneOlderThan(30)).toBe(1)
      expect(cache.size()).toBe(1)
      expect(cache.get('fresh')).toEqual({ id: 2, name: 'fresh' })
      expect(cache.get('old')).toBeUndefined()
    })

    it('pruneOlderThan treats entries with unparseable fetched_at as old', () => {
      const file = path.join(tmpDir, 'cache.json')
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            broken: { value: { id: 1, name: 'broken' }, fetched_at: 'not a date' },
          },
        }),
        'utf-8'
      )

      const cache = new JsonCache<SampleEntry>(file)
      expect(cache.pruneOlderThan(30)).toBe(1)
      expect(cache.size()).toBe(0)
    })
  })
})

describe('searchKey', () => {
  it('combines type, title, and year', () => {
    expect(searchKey('movie', 'The Crow', 1994)).toBe('movie|the crow|1994')
  })

  it('lowercases the title for cache deduplication', () => {
    expect(searchKey('movie', 'THE CROW', 1994)).toBe('movie|the crow|1994')
  })

  it('trims whitespace from the title', () => {
    expect(searchKey('movie', '  The Crow  ', 1994)).toBe('movie|the crow|1994')
  })

  it('uses different keys for movies vs shows even with same title/year', () => {
    expect(searchKey('movie', 'Heat', 1995)).not.toBe(searchKey('show', 'Heat', 1995))
  })
})
