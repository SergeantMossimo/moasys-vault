import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeOrCache, probeBatch, type ProbeTask } from '../../../src/probe/helpers'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import type { ProbeData, TagData } from '../../../src/probe/types'

const sampleData = (overrides: Partial<ProbeData> = {}): ProbeData => ({
  size_bytes: 1000,
  duration_seconds: 60,
  bitrate: 320_000,
  video: null,
  audio: { codec: 'flac', bitrate: null, sample_rate: 44100, bit_depth: 16, channels: 2 },
  tags: null,
  ...overrides,
})

/**
 * Mock the actual ffprobe spawn used by helpers internals so probeOrCache /
 * probeBatch can be exercised without a real binary. The mock returns the
 * `sampleData()` shape by default.
 */
vi.mock('../../../src/probe/ffprobe', () => ({
  probeFile: vi.fn(async () => sampleData()),
}))

describe('probeOrCache', () => {
  let tmpDir: string
  let cachePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-helpers-'))
    cachePath = path.join(tmpDir, 'cache.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const task: ProbeTask = {
    relativePath: 'UHD/Movie/Movie.mp4',
    absolutePath: '/fake/path/Movie.mp4',
    category: 'UHD',
    quality: 'UHD',
    mtime: 12345,
    size: 5000,
  }

  it('returns cached data without invoking ffprobe when present', async () => {
    const cache = new ProbeCache(cachePath)
    cache.set(task.relativePath, task.mtime, task.size, sampleData({ size_bytes: 999 }))

    const result = await probeOrCache(task, cache)
    expect(result.size_bytes).toBe(999) // came from cache
  })

  it('calls ffprobe and writes to cache when no hit', async () => {
    const cache = new ProbeCache(cachePath)
    expect(cache.size()).toBe(0)

    await probeOrCache(task, cache)

    expect(cache.size()).toBe(1)
  })

  it('attaches tags via the optional readTags callback on cache miss', async () => {
    const cache = new ProbeCache(cachePath)
    const tags: TagData = {
      title: 'X',
      artist: 'A',
      album_artist: 'A',
      album: 'B',
      year: 2020,
      track: 1,
      total_tracks: null,
      disc: 1,
      total_discs: null,
      genre: null,
    }
    const readTags = vi.fn(async () => tags)

    const result = await probeOrCache(task, cache, readTags)
    expect(result.tags).toEqual(tags)
    expect(readTags).toHaveBeenCalledWith(task.absolutePath)
  })

  it('does not call readTags when the cache hit', async () => {
    const cache = new ProbeCache(cachePath)
    cache.set(task.relativePath, task.mtime, task.size, sampleData())
    const readTags = vi.fn(async () => null)

    await probeOrCache(task, cache, readTags)
    expect(readTags).not.toHaveBeenCalled()
  })
})

describe('probeBatch', () => {
  let tmpDir: string
  let cachePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-batch-'))
    cachePath = path.join(tmpDir, 'cache.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function task(i: number): ProbeTask {
    return {
      relativePath: `UHD/Movie${i}.mp4`,
      absolutePath: `/fake/Movie${i}.mp4`,
      category: 'UHD',
      quality: 'UHD',
      mtime: 100 + i,
      size: 1000 + i,
    }
  }

  it('returns one probed file per task', async () => {
    const cache = new ProbeCache(cachePath)
    const tasks = [task(0), task(1), task(2)]
    const probed = await probeBatch(tasks, cache)
    expect(probed.length).toBe(3)
  })

  it('reports progress per task via the onProgress callback', async () => {
    const cache = new ProbeCache(cachePath)
    const tasks = [task(0), task(1), task(2)]
    const progress = vi.fn()

    await probeBatch(tasks, cache, progress)
    expect(progress).toHaveBeenCalledTimes(3)
    expect(progress).toHaveBeenCalledWith(3, 3, expect.any(Number))
  })

  it('counts cached hits separately from fresh probes', async () => {
    const cache = new ProbeCache(cachePath)
    // Seed task 0 in the cache.
    cache.set(task(0).relativePath, task(0).mtime, task(0).size, sampleData())

    const progress = vi.fn()
    await probeBatch([task(0), task(1)], cache, progress)

    // After processing all, the cached count is 1 (task 0).
    expect(progress).toHaveBeenLastCalledWith(2, 2, 1)
  })

  it('swallows per-file errors and continues the batch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ffprobeMod = await import('../../../src/probe/ffprobe')
    const probeFile = ffprobeMod.probeFile as ReturnType<typeof vi.fn>
    // First call fails, rest succeed.
    probeFile.mockImplementationOnce(async () => {
      throw new Error('mock failure on task 0')
    })

    const cache = new ProbeCache(cachePath)
    const probed = await probeBatch([task(10), task(11)], cache)

    // Only the successful one is returned.
    expect(probed.length).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed: .* mock failure/))

    errorSpy.mockRestore()
  })

  it('emits warn_probe_failed so failures reach warnings.json, not just the console', async () => {
    // Console-only reporting meant an unplayable file (broken moov atom,
    // 81% zero-fill) was absent from probe.json, still listed as a normal
    // episode in the catalog, and completely absent from warnings.json.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ffprobeMod = await import('../../../src/probe/ffprobe')
    const probeFile = ffprobeMod.probeFile as ReturnType<typeof vi.fn>
    probeFile.mockImplementationOnce(async () => {
      throw new Error('moov atom not found')
    })

    const cache = new ProbeCache(cachePath)
    const warnings = new WarningCollector()
    await probeBatch([task(10), task(11)], cache, undefined, undefined, warnings)

    const fired = warnings.all().filter(w => w.type === 'warn_probe_failed')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.issue).toContain('moov atom not found')
    expect(fired[0]!.path).toBe(task(10).relativePath)

    errorSpy.mockRestore()
  })

  it('still works without a collector — the parameter is optional', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ffprobeMod = await import('../../../src/probe/ffprobe')
    const probeFile = ffprobeMod.probeFile as ReturnType<typeof vi.fn>
    probeFile.mockImplementationOnce(async () => {
      throw new Error('mock failure')
    })

    const cache = new ProbeCache(cachePath)
    await expect(probeBatch([task(10), task(11)], cache)).resolves.toHaveLength(1)

    errorSpy.mockRestore()
  })
})
