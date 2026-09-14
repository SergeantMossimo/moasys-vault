import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'

import { ProbeCache } from '../../../src/probe/cache'
import {
  classifyQuality,
  deriveQuality,
  probeOrCache,
  type ProbeTask,
  type QualityBucket,
} from '../../../src/probe/helpers'
import type { ProbeData } from '../../../src/probe/types'

const buckets: QualityBucket[] = [
  { name: 'UHD', min_width: 2000 },
  { name: 'HD', min_width: 1000, max_width: 2000 },
  { name: 'SD', max_width: 1000 },
]

describe('deriveQuality', () => {
  it('matches a file that falls in the UHD range (long edge >= 2000)', () => {
    expect(deriveQuality(3840, 2160, buckets)).toBe('UHD')
  })

  it('matches a file that falls in the HD range', () => {
    expect(deriveQuality(1920, 1080, buckets)).toBe('HD')
  })

  it('matches a file that falls in the SD range (long edge <= 1000)', () => {
    expect(deriveQuality(720, 480, buckets)).toBe('SD')
  })

  it('uses long edge so vertically-oriented files classify by their largest dimension', () => {
    // 1080 wide x 1920 tall - long edge is 1920, in HD range.
    expect(deriveQuality(1080, 1920, buckets)).toBe('HD')
  })

  it('returns null when no bucket range contains the long edge', () => {
    // long edge 0 falls in SD by virtue of <= 1000, but a true no-match
    // needs no overlap. Build a bucket set with a gap to test it.
    const gappy: QualityBucket[] = [
      { name: 'UHD', min_width: 3000 },
      { name: 'SD', max_width: 500 },
    ]
    expect(deriveQuality(1000, 1000, gappy)).toBeNull()
  })

  it('returns null when buckets is empty', () => {
    expect(deriveQuality(1920, 1080, [])).toBeNull()
  })

  it('scans buckets in declaration order and returns the first match', () => {
    // Two overlapping buckets - first one wins.
    const overlap: QualityBucket[] = [
      { name: 'First', min_width: 1000, max_width: 2000 },
      { name: 'Second', min_width: 1500, max_width: 2500 },
    ]
    expect(deriveQuality(1920, 1080, overlap)).toBe('First')
  })

  it('handles bucket with no min_width (only max_width)', () => {
    expect(deriveQuality(500, 300, [{ name: 'SD', max_width: 1000 }])).toBe('SD')
  })

  it('handles bucket with no max_width (only min_width)', () => {
    expect(deriveQuality(4000, 2000, [{ name: 'UHD', min_width: 2000 }])).toBe('UHD')
  })

  it('handles bucket with neither min_width nor max_width (matches everything)', () => {
    expect(deriveQuality(1, 1, [{ name: 'Any' }])).toBe('Any')
  })

  it('treats min_width as inclusive', () => {
    expect(deriveQuality(2000, 100, [{ name: 'UHD', min_width: 2000 }])).toBe('UHD')
  })

  it('treats max_width as inclusive', () => {
    expect(deriveQuality(1000, 100, [{ name: 'SD', max_width: 1000 }])).toBe('SD')
  })
})

describe('classifyQuality', () => {
  it('returns bucket=null and fits=true when quality is null (general tag)', () => {
    const result = classifyQuality(3840, 2160, null, buckets)
    expect(result.bucket).toBeNull()
    expect(result.fits).toBe(true)
    expect(result.longEdge).toBe(3840)
  })

  it('reports fits=true when the file is in its matching bucket range', () => {
    const result = classifyQuality(3840, 2160, 'UHD', buckets)
    expect(result.bucket?.name).toBe('UHD')
    expect(result.fits).toBe(true)
  })

  it('reports fits=false when the file is in its matching bucket but undersized', () => {
    // File classified as UHD but actually only HD-sized (1920px).
    const result = classifyQuality(1920, 1080, 'UHD', buckets)
    expect(result.bucket?.name).toBe('UHD')
    expect(result.fits).toBe(false)
  })

  it('reports fits=false when the file exceeds the bucket max', () => {
    // File classified as SD but actually 4K.
    const result = classifyQuality(3840, 2160, 'SD', buckets)
    expect(result.bucket?.name).toBe('SD')
    expect(result.fits).toBe(false)
  })

  it('uses long edge for dimension check', () => {
    // 1080 wide x 1920 tall - long edge 1920, fits HD.
    const result = classifyQuality(1080, 1920, 'HD', buckets)
    expect(result.bucket?.name).toBe('HD')
    expect(result.fits).toBe(true)
    expect(result.longEdge).toBe(1920)
  })

  it('passes silently when the quality has no matching bucket name', () => {
    // No bucket called "Documentary" — passes silently regardless of dimensions.
    const result = classifyQuality(1920, 1080, 'Documentary', buckets)
    expect(result.bucket).toBeNull()
    expect(result.fits).toBe(true)
  })

  it('catches files in "Other X" categories now that quality is auto-mapped', () => {
    // The whole point of Step 1+3: a file in `Other UHD` (quality detects to "UHD")
    // with HD-sized dimensions now FAILS its bucket check.
    const result = classifyQuality(1920, 1080, 'UHD', buckets)
    expect(result.bucket?.name).toBe('UHD')
    expect(result.fits).toBe(false)
  })
})

describe('probeOrCache — tag backfill', () => {
  const tags = {
    title: 'Chapter 1',
    artist: 'Andy Weir',
    album_artist: null,
    album: 'The Martian',
    year: null,
    track: 1,
    total_tracks: null,
    disc: null,
    total_discs: null,
    genre: null,
  }
  const task: ProbeTask = {
    relativePath: 'Audible/Andy Weir/The Martian/01 - Chapter 1.mp3',
    absolutePath: '/nonexistent/01 - Chapter 1.mp3',
    category: 'Audible',
    quality: null,
    mtime: 1,
    size: 100,
  }
  const cached = (overrides: Partial<ProbeData> = {}): ProbeData => ({
    size_bytes: 100,
    duration_seconds: 60,
    bitrate: 64_000,
    video: null,
    audio: null,
    tags: null,
    ...overrides,
  })

  function cacheWith(data: ProbeData): ProbeCache {
    const cache = new ProbeCache(path.join(os.tmpdir(), 'moasys-never-written.json'))
    cache.set(task.relativePath, task.mtime, task.size, data)
    return cache
  }

  it('reads tags onto a cache hit that was never tag-read, without re-probing', async () => {
    const cache = cacheWith(cached())
    const readTags = vi.fn().mockResolvedValue(tags)
    const data = await probeOrCache(task, cache, readTags)
    expect(readTags).toHaveBeenCalledOnce()
    expect(data.tags).toEqual(tags)
    expect(cache.get(task.relativePath, task.mtime, task.size)?.tags_read).toBe(true)
  })

  it('does not re-read an entry already marked tags_read, even with no tags', async () => {
    const readTags = vi.fn()
    await probeOrCache(task, cacheWith(cached({ tags_read: true })), readTags)
    expect(readTags).not.toHaveBeenCalled()
  })

  it('treats an entry that already carries tags as read', async () => {
    const readTags = vi.fn()
    await probeOrCache(task, cacheWith(cached({ tags })), readTags)
    expect(readTags).not.toHaveBeenCalled()
  })
})
