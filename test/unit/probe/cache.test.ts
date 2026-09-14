import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ProbeCache } from '../../../src/probe/cache'
import { CACHE_VERSION, type ProbeData } from '../../../src/probe/types'

const sampleData = (overrides: Partial<ProbeData> = {}): ProbeData => ({
  size_bytes: 1000,
  duration_seconds: 60,
  bitrate: 320_000,
  video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
  audio: null,
  tags: null,
  ...overrides,
})

describe('ProbeCache', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-cache-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('starts empty when the cache file does not exist', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    expect(cache.size()).toBe(0)
  })

  it('round-trips data through set + get on the same instance', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    cache.set('UHD/Movie/Movie.mp4', 12345, 5000, sampleData())
    const result = cache.get('UHD/Movie/Movie.mp4', 12345, 5000)
    expect(result).toEqual(sampleData())
  })

  it('returns null when the path is unknown', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    expect(cache.get('Unknown.mp4', 1, 1)).toBeNull()
  })

  it('returns null when mtime differs (file modified)', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    cache.set('a.mp4', 100, 5000, sampleData())
    expect(cache.get('a.mp4', 200, 5000)).toBeNull()
  })

  it('returns null when size differs (file rewritten)', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    cache.set('a.mp4', 100, 5000, sampleData())
    expect(cache.get('a.mp4', 100, 6000)).toBeNull()
  })

  it('overwrites existing entries on set', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    cache.set('a.mp4', 100, 5000, sampleData())
    cache.set('a.mp4', 100, 5000, sampleData({ size_bytes: 9999 }))
    expect(cache.get('a.mp4', 100, 5000)?.size_bytes).toBe(9999)
  })

  it('normalizes Windows path separators to forward slashes in cache keys', () => {
    const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
    cache.set('UHD\\Movie\\Movie.mp4', 100, 5000, sampleData())
    // Lookup with either separator finds the same entry.
    expect(cache.get('UHD/Movie/Movie.mp4', 100, 5000)).not.toBeNull()
  })

  it('persists to disk via save() and loads back via constructor', () => {
    const cachePath = path.join(tmpDir, 'cache.json')

    const writer = new ProbeCache(cachePath)
    writer.set('UHD/Movie/Movie.mp4', 12345, 5000, sampleData())
    writer.save()

    const reader = new ProbeCache(cachePath)
    expect(reader.size()).toBe(1)
    expect(reader.get('UHD/Movie/Movie.mp4', 12345, 5000)).toEqual(sampleData())
  })

  it('discards a cache file with a mismatched version', () => {
    const cachePath = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: CACHE_VERSION + 99,
        entries: [{ path: 'a.mp4', mtime: 1, size: 1, data: sampleData() }],
      }),
      'utf-8'
    )

    const cache = new ProbeCache(cachePath)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Cache version mismatch/))
  })

  it('discards a corrupt JSON cache file', () => {
    const cachePath = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(cachePath, '{ not valid json', 'utf-8')

    const cache = new ProbeCache(cachePath)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Corrupt cache file/))
  })

  it('discards a cache file with an unexpected shape', () => {
    const cachePath = path.join(tmpDir, 'cache.json')
    fs.writeFileSync(cachePath, JSON.stringify({ not: 'a cache' }), 'utf-8')

    const cache = new ProbeCache(cachePath)
    expect(cache.size()).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/unexpected shape/))
  })

  it('writes the cache file with version field on save', () => {
    const cachePath = path.join(tmpDir, 'cache.json')
    const cache = new ProbeCache(cachePath)
    cache.set('a.mp4', 1, 1, sampleData())
    cache.save()

    const written = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(written.version).toBe(CACHE_VERSION)
    expect(written.entries).toHaveLength(1)
  })

  it('sorts entries alphabetically on save for stable diffs', () => {
    const cachePath = path.join(tmpDir, 'cache.json')
    const cache = new ProbeCache(cachePath)
    cache.set('c.mp4', 1, 1, sampleData())
    cache.set('a.mp4', 1, 1, sampleData())
    cache.set('b.mp4', 1, 1, sampleData())
    cache.save()

    const written = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    expect(written.entries.map((e: { path: string }) => e.path)).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4',
    ])
  })

  it('creates parent directories on save if they do not exist', () => {
    const cachePath = path.join(tmpDir, 'nested', 'cache.json')
    const cache = new ProbeCache(cachePath)
    cache.set('a.mp4', 1, 1, sampleData())
    cache.save()
    expect(fs.existsSync(cachePath)).toBe(true)
  })

  describe('pruneOrphans', () => {
    it('returns 0 and removes nothing when every entry still exists on disk', () => {
      const root = path.join(tmpDir, 'media')
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(root, 'sub', 'a.mp4'), '')
      fs.writeFileSync(path.join(root, 'sub', 'b.mp4'), '')

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('sub/a.mp4', 1, 1, sampleData())
      cache.set('sub/b.mp4', 1, 1, sampleData())

      expect(cache.pruneOrphans(root)).toBe(0)
      expect(cache.size()).toBe(2)
    })

    it('drops entries whose files no longer exist under rootPath', () => {
      const root = path.join(tmpDir, 'media')
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'kept.mp4'), '')

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('kept.mp4', 1, 1, sampleData())
      cache.set('gone.mp4', 1, 1, sampleData())
      cache.set('also-gone.mp4', 1, 1, sampleData())
      expect(cache.size()).toBe(3)

      expect(cache.pruneOrphans(root)).toBe(2)
      expect(cache.size()).toBe(1)
      expect(cache.get('kept.mp4', 1, 1)).not.toBeNull()
      expect(cache.get('gone.mp4', 1, 1)).toBeNull()
    })

    it('handles forward-slash cache paths on Windows-style rootPath', () => {
      const root = path.join(tmpDir, 'M')
      fs.mkdirSync(path.join(root, 'Shows', 'X (2020)', 'Season 01'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'Shows', 'X (2020)', 'Season 01', 'X (2020) - S01E01.mp4'),
        ''
      )

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      // Cache stores forward-slash paths even on Windows.
      cache.set('Shows/X (2020)/Season 01/X (2020) - S01E01.mp4', 1, 1, sampleData())

      expect(cache.pruneOrphans(root)).toBe(0)
      expect(cache.size()).toBe(1)
    })

    it('skips the disk check for paths the probe pass just saw, with the same result', () => {
      const root = path.join(tmpDir, 'media')
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'on-disk.mp4'), '')

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('on-disk.mp4', 1, 1, sampleData())
      cache.set('seen-but-not-stat-checked.mp4', 1, 1, sampleData())
      cache.set('gone.mp4', 1, 1, sampleData())

      const exists = vi.spyOn(fs, 'existsSync')
      const removed = cache.pruneOrphans(root, [], new Set(['seen-but-not-stat-checked.mp4']))
      const checked = exists.mock.calls.map(c => String(c[0]))
      exists.mockRestore()

      expect(removed).toBe(1)
      expect(cache.get('gone.mp4', 1, 1)).toBeNull()
      expect(cache.get('seen-but-not-stat-checked.mp4', 1, 1)).not.toBeNull()
      expect(checked.some(p => p.endsWith('seen-but-not-stat-checked.mp4'))).toBe(false)
    })

    it('prunes nothing when the root folder itself is missing (disconnected drive, moved folder)', () => {
      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('HD/Show (2020)/Season 01/a.mp4', 1, 1, sampleData())
      cache.set('SD/Other (2019)/Season 01/b.mp4', 1, 1, sampleData())

      expect(cache.pruneOrphans(path.join(tmpDir, 'no-such-root'))).toBe(0)
      expect(cache.size()).toBe(2)
    })

    it('keeps entries under a missing category folder but prunes real orphans elsewhere', () => {
      const root = path.join(tmpDir, 'media')
      fs.mkdirSync(path.join(root, 'HD'), { recursive: true })
      fs.writeFileSync(path.join(root, 'HD', 'kept.mp4'), '')

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('HD/kept.mp4', 1, 1, sampleData())
      cache.set('HD/deleted.mp4', 1, 1, sampleData())
      cache.set('SD/whole-folder-missing.mp4', 1, 1, sampleData())

      expect(cache.pruneOrphans(root, ['SD'])).toBe(1)
      expect(cache.get('HD/deleted.mp4', 1, 1)).toBeNull()
      expect(cache.get('SD/whole-folder-missing.mp4', 1, 1)).not.toBeNull()
    })

    it('matches keep prefixes case-insensitively and only on whole folder names', () => {
      const root = path.join(tmpDir, 'media')
      fs.mkdirSync(root, { recursive: true })

      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      cache.set('Other SD/a.mp4', 1, 1, sampleData())
      cache.set('SD Extras/b.mp4', 1, 1, sampleData())

      expect(cache.pruneOrphans(root, ['other sd'])).toBe(1)
      expect(cache.get('Other SD/a.mp4', 1, 1)).not.toBeNull()
      expect(cache.get('SD Extras/b.mp4', 1, 1)).toBeNull()
    })

    it('is a no-op on an empty cache', () => {
      const cache = new ProbeCache(path.join(tmpDir, 'cache.json'))
      expect(cache.pruneOrphans(tmpDir)).toBe(0)
      expect(cache.size()).toBe(0)
    })
  })
})
