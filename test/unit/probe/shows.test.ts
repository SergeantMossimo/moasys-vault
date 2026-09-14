import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeShows } from '../../../src/probe/shows'
import { defaultShowsRules, type ShowsRules } from '../../../src/core/rules/shows'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import type { ProbeData } from '../../../src/probe/types'
import { buildLibrary, fakeProbe, type DirSpec } from '../../fixtures/library'

function primeCache(cachePath: string, root: string, data: Record<string, ProbeData>): ProbeCache {
  const cache = new ProbeCache(cachePath)
  for (const [relPath, probeData] of Object.entries(data)) {
    const stat = fs.statSync(path.join(root, relPath))
    cache.set(relPath, stat.mtimeMs, stat.size, probeData)
  }
  return cache
}

describe('probeShows', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-shows-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  function setup(opts: {
    spec: DirSpec
    rules?: Partial<ShowsRules>
    probes: Record<string, ProbeData>
  }) {
    const rules: ShowsRules = {
      ...defaultShowsRules,
      categories: [{ name: 'UHD' }, { name: 'HD' }, { name: 'SD' }],
      quality_thresholds: [
        { name: 'UHD', min_width: 2000 },
        { name: 'HD', min_width: 1000, max_width: 2000 },
        { name: 'SD', max_width: 1000 },
      ],
      ...opts.rules,
    }
    const root = buildLibrary(opts.spec, 'moasys-probeshows-')
    const cache = primeCache(path.join(tmpDir, 'probe.json'), root, opts.probes)
    const warnings = new WarningCollector()
    return { rules, root, cache, warnings }
  }

  it('aggregates by show and season', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '',
              'Show (2020) - S01E02.mp4': '',
            },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E02.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    expect(result.output).toHaveLength(1)
    expect(result.output[0]?.seasons[0]?.episodes).toHaveLength(2)
  })

  it('emits warn_quality_mismatch for episodes outside the bucket range', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })

    await probeShows({ root_path: root }, rules, cache, warnings)
    expect(warnings.all().some(w => w.issue.match(/Quality mismatch/))).toBe(true)
  })

  it('summarizes warn_quality_mismatch once per season, with counts, resolutions and codes', async () => {
    const ep = (s: string, e: string) => `Show (2020) - S${s}E${e}.mp4`
    const sd = (w = 720, h = 404) =>
      fakeProbe({ video: { codec: 'h264', width: w, height: h, frame_rate: 24 } })
    const hd = () =>
      fakeProbe({ video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 } })
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { [ep('01', '01')]: '', [ep('01', '02')]: '', [ep('01', '03')]: '' },
            'Season 02': { [ep('02', '01')]: '', [ep('02', '02')]: '' },
          },
        },
      },
      probes: {
        [`HD/Show (2020)/Season 01/${ep('01', '01')}`]: sd(),
        [`HD/Show (2020)/Season 01/${ep('01', '02')}`]: sd(640, 480),
        [`HD/Show (2020)/Season 01/${ep('01', '03')}`]: hd(),
        [`HD/Show (2020)/Season 02/${ep('02', '01')}`]: hd(),
        [`HD/Show (2020)/Season 02/${ep('02', '02')}`]: hd(),
      },
    })

    await probeShows({ root_path: root }, rules, cache, warnings)
    const rows = warnings.all().filter(w => w.type === 'warn_quality_mismatch')

    // Season 02 fits entirely, so only Season 01 is reported — once.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toBe('HD/Show (2020)/Season 01')
    expect(rows[0]!.issue).toMatch(
      /^Quality mismatch — 2 of 3 episode file\(s\) don't fit bucket 'HD'/
    )
    expect(rows[0]!.issue).toContain('640x480 (fits SD) ×1')
    expect(rows[0]!.issue).toContain('720x404 (fits SD) ×1')
    expect(rows[0]!.issue).toContain('Episodes: S01E01, S01E02.')
  })

  it('groups repeated resolutions and caps the samples it lists', async () => {
    const files: Record<string, string> = {}
    const probes: Record<string, ProbeData> = {}
    const widths = [720, 720, 720, 640, 480, 320]
    widths.forEach((w, i) => {
      const name = `Show (2020) - S01E0${i + 1}.mp4`
      files[name] = ''
      probes[`HD/Show (2020)/Season 01/${name}`] = fakeProbe({
        video: { codec: 'h264', width: w, height: 400, frame_rate: 24 },
      })
    })
    const { rules, root, cache, warnings } = setup({
      spec: { HD: { 'Show (2020)': { 'Season 01': files } } },
      probes,
    })

    await probeShows({ root_path: root }, rules, cache, warnings)
    const issue = warnings.all().find(w => w.type === 'warn_quality_mismatch')!.issue

    expect(issue).toMatch(/6 of 6 episode file/)
    expect(issue).toContain('720x400 (fits SD) ×3')
    expect(issue).toContain(', +1 more.')
    expect(issue).toContain('Episodes: S01E01, S01E02, S01E03, +3 more.')
  })

  it('respects ignored_season_names for named seasons', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            Specials: { 'Show (2020) - S00E01.mp4': '' },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Specials/Show (2020) - S00E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    expect(result.output[0]?.seasons[0]?.season).toBe('Specials')
  })

  it('skips seasons that do not match the season pattern and are not named', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            S1: { 'Show (2020) - S01E01.mp4': '' }, // bad name, no probe
          },
        },
      },
      probes: {}, // no cache entries; probeBatch would spawn ffprobe, but the
      // file is unreachable from collectTasks because the season was skipped.
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    expect(result.output).toEqual([])
  })

  it('orders numeric seasons before named ones (seasonSortKey)', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            Specials: { 'Show (2020) - S00E01.mp4': '' },
            'Season 02': { 'Show (2020) - S02E01.mp4': '' },
            'Season 10': { 'Show (2020) - S10E01.mp4': '' },
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Specials/Show (2020) - S00E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 02/Show (2020) - S02E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 10/Show (2020) - S10E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    // Numeric ASC, then named alphabetic — so "1", "2", "10", "Specials".
    expect(result.output[0]?.seasons.map(s => s.season)).toEqual(['1', '2', '10', 'Specials'])
  })

  it('formats single-episode and multi-episode IDs correctly', async () => {
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '',
              'Show (2020) - S01E02-E03.mp4': '',
            },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E02-E03.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    const episodeIds = result.output[0]?.seasons[0]?.episodes.map(e => e.episode) ?? []
    expect(episodeIds).toContain('S01E01')
    expect(episodeIds).toContain('S01E02-E03')
  })
})
