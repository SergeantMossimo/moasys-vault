import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeMovies } from '../../../src/probe/movies'
import { defaultMoviesRules, type MoviesRules } from '../../../src/core/rules/movies'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import type { ProbeData } from '../../../src/probe/types'
import { buildLibrary, fakeProbe, type DirSpec } from '../../fixtures/library'

/**
 * Pre-populate the ProbeCache with entries for every file in the fixture
 * library so probeBatch never spawns ffprobe. Returns the seeded cache.
 *
 * The cache key is `relativePath|mtime|size`, so we must stat each fixture
 * file (the OS chooses mtime when the file is created) to compute matching
 * keys. Callers supply the ProbeData for each relative path.
 */
function primeCache(cachePath: string, root: string, data: Record<string, ProbeData>): ProbeCache {
  const cache = new ProbeCache(cachePath)
  for (const [relPath, probeData] of Object.entries(data)) {
    const abs = path.join(root, relPath)
    const stat = fs.statSync(abs)
    cache.set(relPath, stat.mtimeMs, stat.size, probeData)
  }
  return cache
}

describe('probeMovies', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-movies-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function setup(opts: {
    spec: DirSpec
    rules?: Partial<MoviesRules>
    probes: Record<string, ProbeData>
  }) {
    const rules: MoviesRules = {
      ...defaultMoviesRules,
      categories: [{ name: 'UHD' }, { name: 'HD' }, { name: 'SD' }],
      quality_thresholds: [
        { name: 'UHD', min_width: 2000 },
        { name: 'HD', min_width: 1000, max_width: 2000 },
        { name: 'SD', max_width: 1000 },
      ],
      ...opts.rules,
    }
    const root = buildLibrary(opts.spec, 'moasys-probemovies-')
    const cache = primeCache(path.join(tmpDir, 'probe.json'), root, opts.probes)
    const warnings = new WarningCollector()
    return { rules, root, cache, warnings }
  }

  it('returns the aggregated output and the byPath map', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
      },
      probes: {
        'UHD/The Crow (1994)/The Crow (1994).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
      },
    })

    const result = await probeMovies({ root_path: root }, rules, cache, warnings)

    expect(result.output).toHaveLength(1)
    expect(result.output[0]?.title).toBe('The Crow')
    expect(result.byPath.size).toBe(1)
    expect(result.byPath.has('UHD/The Crow (1994)/The Crow (1994).mp4')).toBe(true)
  })

  it('emits warn_quality_mismatch when a file in a quality-bucket category does not fit', () => {
    // SD-dimension file in HD/ folder triggers the mismatch warning.
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })
    return probeMovies({ root_path: root }, rules, cache, warnings).then(() => {
      expect(warnings.all().some(w => w.issue.match(/Quality mismatch/))).toBe(true)
    })
  })

  it('fires warn_quality_mismatch for files in "Other HD" — auto-detected quality maps to HD bucket', async () => {
    // After the auto-detect change: "Other HD" → quality "HD" → has bucket → 720x480 fails.
    const { rules, root, cache, warnings } = setup({
      spec: { 'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: {
        categories: [{ name: 'Other HD' }],
      },
      probes: {
        'Other HD/X (2000)/X (2000).mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Quality mismatch/))).toBe(true)
  })

  it('skips warn_quality_mismatch for general-tag categories with no detected quality', async () => {
    // A "Documentary" category has no UHD/HD/SD substring → quality null → silent pass.
    const { rules, root, cache, warnings } = setup({
      spec: { Documentary: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: {
        categories: [{ name: 'Documentary' }],
      },
      probes: {
        'Documentary/X (2000)/X (2000).mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Quality mismatch/))).toBe(false)
  })

  it('silences warn_quality_mismatch when the toggle is false', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: {
        checks: { ...defaultMoviesRules.checks, warn_quality_mismatch: false },
      },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Quality mismatch/))).toBe(false)
  })

  it('emits warn_short_duration for a file at or below min_duration_minutes', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'Short (2000)': { 'Short (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/Short (2000)/Short (2000).mp4': fakeProbe({
          duration_seconds: 125,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    const hit = warnings.all().find(w => w.type === 'warn_short_duration')
    expect(hit).toBeDefined()
    expect(hit?.issue).toMatch(/Short runtime — 2m 05s/)
  })

  it('fires warn_short_duration exactly at the threshold (at-or-below, not strictly-below)', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 1800,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(true)
  })

  it('stays silent one second over the threshold', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 1801,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(false)
  })

  it('fires warn_short_duration on a zero-length container', async () => {
    // The most valuable hit this check produces — a broken encode.
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 0,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(true)
  })

  it('stays silent when duration was never measured (null)', async () => {
    // Unreadable files are warn_probe_failed's job, not this check's.
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: null,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(false)
  })

  it('disables warn_short_duration when min_duration_minutes is 0', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 0 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 60,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(false)
  })

  it('silences warn_short_duration when the toggle is false', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: {
        min_duration_minutes: 30,
        checks: { ...defaultMoviesRules.checks, warn_short_duration: false },
      },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 60,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(false)
  })

  it('points warn_short_duration at the ignore-file escape hatch', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: { min_duration_minutes: 30 },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 60,
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    const hit = warnings.all().find(w => w.type === 'warn_short_duration')
    expect(hit?.issue).toMatch(/ignored\/<drive>\/movies\.yaml/)
    expect(hit?.issue).toMatch(/types: \[warn_short_duration\]/)
  })

  it('fires warn_short_duration in a general-tag category, unlike warn_quality_mismatch', async () => {
    // "Documentary" has no UHD/HD/SD substring → quality null. The runtime
    // check is not gated on quality, so it still fires.
    const { rules, root, cache, warnings } = setup({
      spec: { Documentary: { 'X (2000)': { 'X (2000).mp4': '' } } },
      rules: {
        categories: [{ name: 'Documentary' }],
        min_duration_minutes: 30,
      },
      probes: {
        'Documentary/X (2000)/X (2000).mp4': fakeProbe({
          duration_seconds: 60,
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.type === 'warn_short_duration')).toBe(true)
    expect(warnings.all().some(w => w.type === 'warn_quality_mismatch')).toBe(false)
  })

  it('skips a file with no video stream (audio-only is rare here)', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      probes: {
        'HD/X (2000)/X (2000).mp4': fakeProbe({ video: null }),
      },
    })

    await probeMovies({ root_path: root }, rules, cache, warnings)
    // No video means classifyQuality is skipped entirely; no warning.
    expect(warnings.all()).toEqual([])
  })

  it('parses {edition-} empty-edition file stems as null edition (matches scan)', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        UHD: {
          'The Crow (1994)': { 'The Crow (1994) {edition-}.mp4': '' },
        },
      },
      probes: {
        'UHD/The Crow (1994)/The Crow (1994) {edition-}.mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
      },
    })

    const result = await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(result.output[0]?.edition).toBeNull()
  })

  it('sorts the aggregated output by title, then year, then edition', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        UHD: {
          'Beta (2000)': { 'Beta (2000).mp4': '' },
          'Alpha (2010)': { 'Alpha (2010).mp4': '' },
          'Alpha (2000)': { 'Alpha (2000).mp4': '' },
          'Same Movie (2000)': {
            'Same Movie (2000) {edition-Directors Cut}.mp4': '',
            'Same Movie (2000) {edition-Theatrical}.mp4': '',
          },
        },
      },
      probes: {
        'UHD/Beta (2000)/Beta (2000).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'UHD/Alpha (2010)/Alpha (2010).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'UHD/Alpha (2000)/Alpha (2000).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'UHD/Same Movie (2000)/Same Movie (2000) {edition-Directors Cut}.mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'UHD/Same Movie (2000)/Same Movie (2000) {edition-Theatrical}.mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
      },
    })

    const result = await probeMovies({ root_path: root }, rules, cache, warnings)
    const order = result.output.map(m => `${m.title}-${m.year}-${m.edition ?? ''}`)
    // Title ASC; within same title, year ASC; within same year, edition ASC.
    expect(order).toEqual([
      'Alpha-2000-',
      'Alpha-2010-',
      'Beta-2000-',
      'Same Movie-2000-Directors Cut',
      'Same Movie-2000-Theatrical',
    ])
  })

  it('skips category folders that do not exist on disk', async () => {
    const { rules, root, cache, warnings } = setup({
      // Configure UHD + HD + SD, but only build UHD.
      spec: { UHD: { 'X (2000)': { 'X (2000).mp4': '' } } },
      probes: {
        'UHD/X (2000)/X (2000).mp4': fakeProbe({
          video: { codec: 'h264', width: 3840, height: 2160, frame_rate: 24 },
        }),
      },
    })

    const result = await probeMovies({ root_path: root }, rules, cache, warnings)
    expect(result.output).toHaveLength(1)
  })
})
