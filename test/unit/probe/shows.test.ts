import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { probeShows } from '../../../src/probe/shows'
import { defaultShowsRules, type ShowsRules } from '../../../src/core/rules/shows'
import { ProbeCache } from '../../../src/probe/cache'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
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
    /** Level-keyed ignore file contents, as `ignored/<drive>/shows.yaml` parses. */
    ignored?: Record<string, string[]>
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
    const warnings = new WarningCollector(
      opts.ignored && parseIgnoreList(opts.ignored, 'shows', 'test.yaml')
    )
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
    expect(result.output[0]?.edition).toBeNull()
    expect(result.output[0]?.seasons[0]?.episodes).toHaveLength(2)
  })

  /**
   * Keyed on the edition as well as title+year, matching the scan pass. Fold
   * them together and one edition's season absorbs the other's episodes, which
   * would also collapse the per-season quality-mismatch summary.
   */
  it('keeps two editions of one series as separate entries', async () => {
    const color = 'HD/Spider-Noir (2026) {edition-True Hue Color}/Season 01'
    const bw = 'HD/Spider-Noir (2026) {edition-Authentic Black and White}/Season 01'
    const { rules, root, cache, warnings } = setup({
      spec: {
        HD: {
          'Spider-Noir (2026) {edition-True Hue Color}': {
            'Season 01': { 'Spider-Noir (2026) - S01E01.mp4': '' },
          },
          'Spider-Noir (2026) {edition-Authentic Black and White}': {
            'Season 01': { 'Spider-Noir (2026) - S01E01.mp4': '' },
          },
        },
      },
      probes: {
        [`${color}/Spider-Noir (2026) - S01E01.mp4`]: fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        [`${bw}/Spider-Noir (2026) - S01E01.mp4`]: fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })

    const result = await probeShows({ root_path: root }, rules, cache, warnings)
    expect(result.output).toHaveLength(2)
    expect(result.output.map(s => s.edition)).toEqual([
      'Authentic Black and White',
      'True Hue Color',
    ])
    for (const show of result.output) {
      expect(show.seasons[0]?.episodes).toHaveLength(1)
    }
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
    expect(warnings.all().some(w => w.type === 'warn_quality_mismatch')).toBe(true)
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
    expect(rows[0]!.issue).toMatch(/^2\/3 episodes are /)
    expect(rows[0]!.issue).toContain('640x480 (fits SD) ×1')
    expect(rows[0]!.issue).toContain('720x404 (fits SD) ×1')
    expect(rows[0]!.issue).toContain('not HD (1000–2000px).')
    expect(rows[0]!.issue).toContain('S01E01, S01E02.')
  })

  it('leaves an `episodes:` entry out of the season summary, dropping the row once none remain', async () => {
    // The row is written for the season folder, which an entry naming one
    // file sits beneath — so the file has to be left out before summarizing.
    const ep = (e: string) => `Show (2020) - S01E${e}.mp4`
    const sd = () =>
      fakeProbe({ video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 } })
    const run = async (ignored: Record<string, string[]>) => {
      const { rules, root, cache, warnings } = setup({
        spec: { HD: { 'Show (2020)': { 'Season 01': { [ep('01')]: '', [ep('02')]: '' } } } },
        probes: {
          [`HD/Show (2020)/Season 01/${ep('01')}`]: sd(),
          [`HD/Show (2020)/Season 01/${ep('02')}`]: sd(),
        },
        ignored,
      })
      await probeShows({ root_path: root }, rules, cache, warnings)
      return warnings.all().filter(w => w.type === 'warn_quality_mismatch')
    }

    const one = await run({ episodes: ['Show (2020)/S01E01'] })
    expect(one).toHaveLength(1)
    expect(one[0]!.issue).toMatch(/^1\/2 episodes are /)
    expect(one[0]!.issue).toContain('S01E02.')
    expect(one[0]!.issue).not.toContain('S01E01')

    expect(await run({ episodes: ['Show (2020)/S01E01', 'Show (2020)/S01E02'] })).toEqual([])
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

    expect(issue).toMatch(/6\/6 episodes are /)
    expect(issue).toContain('720x400 (fits SD) ×3')
    expect(issue).toContain(', +1 more')
    expect(issue).toContain('S01E01, S01E02, S01E03, +3 more.')
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

describe('probeShows — warn_large_file', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-probe-shows-large-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  const HD_VIDEO = { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 }
  const bytesAt = (mbps: number, seconds: number) => (mbps * 1e6 * seconds) / 8
  const file = (n: number) => `Show (2020) - S01E${String(n).padStart(2, '0')}.mp4`
  const rel = (n: number) => `HD/Show (2020)/Season 01/${file(n)}`

  /** One HD season, an episode per entry of `mbps`, each 30 minutes long. */
  async function run(mbps: number[], ignored?: Record<string, string[]>) {
    const rules: ShowsRules = {
      ...defaultShowsRules,
      categories: [{ name: 'HD' }],
      quality_thresholds: [{ name: 'HD', min_width: 1000, max_width: 2000, max_mbps: 8 }],
    }
    const season: Record<string, string> = {}
    const probes: Record<string, ProbeData> = {}
    mbps.forEach((m, i) => {
      season[file(i + 1)] = ''
      probes[rel(i + 1)] = fakeProbe({
        video: HD_VIDEO,
        duration_seconds: 1800,
        size_bytes: bytesAt(m, 1800),
      })
    })
    const root = buildLibrary(
      { HD: { 'Show (2020)': { 'Season 01': season } } },
      'moasys-shows-large-'
    )
    const cache = primeCache(path.join(tmpDir, 'probe.json'), root, probes)
    const warnings = new WarningCollector(ignored && parseIgnoreList(ignored, 'shows', 'test.yaml'))
    await probeShows({ root_path: root }, rules, cache, warnings)
    return warnings.all().filter(w => w.type === 'warn_large_file')
  }

  it('summarizes a season once, largest episodes first', async () => {
    const rows = await run([4, 10, 20, 9, 12, 3])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path).toBe('HD/Show (2020)/Season 01')
    expect(rows[0]?.issue).toBe(
      '4/6 episodes over the HD limit of 8 Mbps: S01E03 20.0 Mbps (4.5 GB), ' +
        'S01E05 12.0 Mbps (2.7 GB), S01E02 10.0 Mbps (2.3 GB), +1 more.'
    )
  })

  it('stays silent when every episode is under the ceiling', async () => {
    expect(await run([4, 7.9])).toEqual([])
  })

  it('leaves an `episodes:` entry out of the summary', async () => {
    const rows = await run([20, 3], { episodes: [`Show (2020)/${file(1)}`] })
    expect(rows).toEqual([])
  })
})
