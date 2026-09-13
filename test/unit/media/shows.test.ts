import { describe, it, expect, vi } from 'vitest'

import { createShowsModule } from '../../../src/media/shows'
import { defaultShowsRules, ShowsRules } from '../../../src/core/rules/shows'
import { scan } from '../../../src/core/scanner'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import {
  buildLibrary,
  cleanupLibrary,
  fakeProbe,
  probeMap,
  type DirSpec,
} from '../../fixtures/library'

function runShowsScan(opts: {
  spec: DirSpec
  rules?: Partial<ShowsRules>
  probes?: Record<string, ReturnType<typeof fakeProbe>>
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
  const root = buildLibrary(opts.spec, 'moasys-shows-')
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const module = createShowsModule(rules)
  const warnings = new WarningCollector(parseIgnoreList(opts.ignored ?? {}, 'shows', 'test.yaml'))
  const probes = probeMap(opts.probes ?? {})

  try {
    const records = scan({ root_path: root }, module, warnings, probes)
    const output = module.serialize(records)
    // `grouped` is the on-disk warnings.json shape — the only view that
    // exercises per-bucket row ordering.
    return { output, warnings: warnings.all(), grouped: warnings.groupedByType() }
  } finally {
    logSpy.mockRestore()
    cleanupLibrary(root)
  }
}

describe('shows module — happy paths', () => {
  it('catalogs a show with a numbered season', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01 - Pilot.mp4': '',
              'Show (2020) - S01E02 - Two.mp4': '',
            },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Season 01/Show (2020) - S01E01 - Pilot.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E02 - Two.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })
    expect(result.output).toEqual([
      {
        title: 'Show',
        year: 2020,
        seasons: [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'HD', quality: 'HD' }],
            episodes: [
              { episode_start: 1, episode_end: 1, title: 'Pilot' },
              { episode_start: 2, episode_end: 2, title: 'Two' },
            ],
          },
        ],
      },
    ])
  })

  it('preserves the named-season label from ignored_season_names', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            Specials: {
              'Show (2020) - S00E01 - Pilot.mp4': '',
            },
          },
        },
      },
    })
    expect(result.output[0]?.seasons[0]?.season).toBe('Specials')
  })

  it('counts multi-episode files as multiple episodes', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01-E02 - Pilot.mp4': '',
            },
          },
        },
      },
    })
    expect(result.output[0]?.seasons[0]?.episode_count).toBe(2)
  })

  it('emits one version per category for a season in multiple categories', () => {
    const result = runShowsScan({
      spec: {
        UHD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
      probes: {
        'UHD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })
    expect(result.output[0]?.seasons[0]?.versions).toEqual([
      { category: 'UHD', quality: 'UHD' },
      { category: 'HD', quality: 'HD' },
    ])
  })

  it('surfaces multiple versions per category for a mixed-quality season', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '', // HD
              'Show (2020) - S01E02.mp4': '', // SD (probe dimensions)
            },
          },
        },
      },
      probes: {
        'HD/Show (2020)/Season 01/Show (2020) - S01E01.mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
        'HD/Show (2020)/Season 01/Show (2020) - S01E02.mp4': fakeProbe({
          video: { codec: 'h264', width: 720, height: 480, frame_rate: 24 },
        }),
      },
    })
    const versions = result.output[0]?.seasons[0]?.versions ?? []
    expect(versions).toContainEqual({ category: 'HD', quality: 'HD' })
    expect(versions).toContainEqual({ category: 'HD', quality: 'SD' })
  })

  it('sorts seasons numerically with named seasons after numeric', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            Specials: { 'Show (2020) - S00E01.mp4': '' },
            'Season 02': { 'Show (2020) - S02E01.mp4': '' },
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
    })
    expect(result.output[0]?.seasons.map(s => s.season)).toEqual(['1', '2', 'Specials'])
  })
})

describe('shows module — warnings', () => {
  it('warn_bad_show_folder: show folder does not match the pattern', () => {
    const result = runShowsScan({
      spec: {
        HD: { ShowNoYear: { 'Season 01': { 'ShowNoYear - S01E01.mp4': '' } } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Show folder name does not match/))).toBe(true)
  })

  it('warn_bad_season_folder: season folder is not "Season XX"', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            S1: { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Season folder.*does not match expected format/))
    ).toBe(true)
  })

  it('warn_bad_file_name: episode file does not match the pattern', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'random.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/File name does not match Plex naming/))).toBe(
      true
    )
  })

  it('warn_show_year_mismatch: episode file references a different show year', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2019) - S01E01.mp4': '' },
          },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/File show\/year .* does not match show folder/))
    ).toBe(true)
  })

  it('warn_show_title_case: capitalization-only drift gets its own bucket', () => {
    // warn_show_year_mismatch lowercases both sides, so before this check
    // existed a whole show could drift on capitalization invisibly.
    const result = runShowsScan({
      spec: {
        HD: {
          'My Name Is Earl (2005)': {
            'Season 01': { 'My Name is Earl (2005) - s01e01.mp4': '' },
          },
        },
      },
    })
    const types = result.warnings.map(w => w.type)
    expect(types).toContain('warn_show_title_case')
    expect(types).not.toContain('warn_show_year_mismatch')
  })

  it('warn_show_title_case: does not fire when the title matches exactly', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'My Name Is Earl (2005)': {
            'Season 01': { 'My Name Is Earl (2005) - s01e01.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.map(w => w.type)).not.toContain('warn_show_title_case')
  })

  it('warn_show_year_mismatch still wins for a genuinely different title', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': { 'Season 01': { 'Other Show (2020) - S01E01.mp4': '' } },
        },
      },
    })
    const types = result.warnings.map(w => w.type)
    expect(types).toContain('warn_show_year_mismatch')
    expect(types).not.toContain('warn_show_title_case')
  })

  it('warn_episode_code_case: summarises off-style codes once per season', () => {
    const result = runShowsScan({
      rules: { episode_code_case: 'lower' },
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '',
              'Show (2020) - S01e02.mp4': '',
              'Show (2020) - s01e03.mp4': '',
            },
          },
        },
      },
    })
    const fired = result.warnings.filter(w => w.type === 'warn_episode_code_case')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.issue).toMatch(/2 of 3 episode file\(s\)/)
  })

  it('warn_episode_code_case: flags the bare multi-episode suffix', () => {
    const result = runShowsScan({
      rules: { episode_code_case: 'lower' },
      spec: {
        HD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - s01e01-02.mp4': '' } },
        },
      },
    })
    const fired = result.warnings.filter(w => w.type === 'warn_episode_code_case')
    expect(fired).toHaveLength(1)
    expect(fired[0]!.issue).toContain("'s01e01-02' should be 's01e01-e02'")
  })

  it('warn_episode_code_case: silent when episode_code_case is "any"', () => {
    const result = runShowsScan({
      rules: { episode_code_case: 'any' },
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '', 'Show (2020) - s01e02.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.map(w => w.type)).not.toContain('warn_episode_code_case')
  })

  it('warn_season_mismatch: file season number disagrees with season folder', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S02E01.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/does not match season folder/))).toBe(true)
  })

  it('warn_episode_gaps: missing episode in a season', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '',
              'Show (2020) - S01E03.mp4': '', // E02 missing
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Potential missing episodes/))).toBe(true)
  })

  it('warn_no_videos: season folder is empty', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': { 'Season 01': { 'poster.jpg': '' } },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/No recognized video files/))).toBe(true)
  })

  it('warn_non_primary: a .mkv file when primary is .mp4', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mkv': '' },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Non-.MP4/))).toBe(true)
  })

  it('warn_loose_files: video files at category root', () => {
    const result = runShowsScan({
      spec: { HD: { 'stray.mp4': '' } },
    })
    expect(result.warnings.some(w => w.issue.match(/loose video/i))).toBe(true)
  })

  it('warn_loose_files: video files directly inside show folder', () => {
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Show (2020) - S01E01.mp4': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose video/i))).toBe(true)
  })

  it('warn_extra_subfolders: nested folder inside a season folder', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': {
              'Show (2020) - S01E01.mp4': '',
              Extras: { 'bonus.mp4': '' },
            },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected subfolder/))).toBe(true)
  })

  it('warn_unexpected_entries: stray .txt at category root', () => {
    const result = runShowsScan({
      spec: { HD: { 'README.txt': '' } },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected file/))).toBe(true)
  })

  it('toggles silence warnings when set to false', () => {
    const result = runShowsScan({
      spec: { HD: { 'random.txt': '' } },
      rules: {
        checks: {
          ...defaultShowsRules.checks,
          warn_unexpected_entries: false,
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected file/))).toBe(false)
  })
})

describe('shows module — ignore list reaches the cross-category checks', () => {
  /** A season present in both HD and SD, which trips warn_multi_quality. */
  const multiQualitySpec: DirSpec = {
    HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
    SD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
  }
  const noHdSdCombo = { acceptable_quality_combos: [['UHD', 'HD']] }

  it('a `shows:` entry silences warn_multi_quality', () => {
    // This is what the level-keyed format exists for. The check emits
    // `Show (2020) — Season 1` — no category, em-dash separated — which the
    // old path-prefix matcher could never reach from any entry.
    const result = runShowsScan({
      spec: multiQualitySpec,
      rules: noHdSdCombo,
      ignored: { shows: ['Show (2020)'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('a `seasons:` entry silences it too, via the Season 1 / Season 01 fold', () => {
    // The check labels the season `Season 1` from the parsed number while the
    // folder on disk is `Season 01`. One entry has to cover both.
    const result = runShowsScan({
      spec: multiQualitySpec,
      rules: noHdSdCombo,
      ignored: { seasons: ['Show (2020)/Season 01'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('a `folders:` entry reaches it despite the path carrying no category', () => {
    const result = runShowsScan({
      spec: multiQualitySpec,
      rules: noHdSdCombo,
      ignored: { folders: ['SD'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('leaves a different show alone', () => {
    const result = runShowsScan({
      spec: multiQualitySpec,
      rules: noHdSdCombo,
      ignored: { shows: ['Other Show (2020)'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(true)
  })

  it('an `episodes:` entry written as a code silences a warning on the file', () => {
    // The scan pass warns about the filename; the TMDB pass warns about the
    // S01E01 code. One entry covers both.
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01 - Bad Name!.mkv': '' } } },
      },
      ignored: { episodes: ['Show (2020)/S01E01'] },
    })
    expect(result.warnings.filter(w => w.path.includes('S01E01'))).toHaveLength(0)
  })
})

describe('shows module — warn_multi_quality (per-season)', () => {
  it('fires when a single season exists in multiple qualities', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
        SD: {
          'Show (2020)': {
            'Season 01': { 'Show (2020) - S01E01.mp4': '' },
          },
        },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']], // HD/SD NOT acceptable
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Season 1 exists in multiple qualities/))).toBe(
      true
    )
  })

  it('does NOT fire when different seasons are in different qualities', () => {
    // The "Game of Thrones DVD + Bluray" case: S01 on DVD, S02 on Bluray.
    const result = runShowsScan({
      spec: {
        SD: {
          'GoT (2011)': {
            'Season 01': { 'GoT (2011) - S01E01.mp4': '' },
          },
        },
        HD: {
          'GoT (2011)': {
            'Season 02': { 'GoT (2011) - S02E01.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/multiple qualities/))).toBe(false)
  })

  it("silenced when the season's quality set matches acceptable_quality_combos", () => {
    const result = runShowsScan({
      spec: {
        UHD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
        HD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.issue.match(/multiple qualities/))).toBe(false)
  })

  it('uses auto-detected qualities so {Other HD, SD} resolves to {HD, SD}', () => {
    const result = runShowsScan({
      spec: {
        'Other HD': {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
        SD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
      },
      rules: {
        categories: [{ name: 'Other HD' }, { name: 'SD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    const w = result.warnings.find(x => x.issue.match(/multiple qualities/))
    expect(w?.issue).toMatch(/HD, SD/) // canonical-order sort
  })

  it('silenced when the toggle is false', () => {
    const result = runShowsScan({
      spec: {
        HD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
        SD: {
          'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } },
        },
      },
      rules: {
        checks: { ...defaultShowsRules.checks, warn_multi_quality: false },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/multiple qualities/))).toBe(false)
  })
})

describe('shows module — warn_duplicate_quality (per-season)', () => {
  it('fires for {UHD, HD, Other HD} while warn_multi_quality stays silent', () => {
    // HD and Other HD both resolve to tier HD, so the tier SET is {UHD, HD} —
    // the whitelisted combo — and multi_quality sees nothing. The third copy
    // is only visible to the cardinality check.
    const result = runShowsScan({
      spec: {
        UHD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        'Other HD': { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'UHD' }, { name: 'HD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    const dupes = result.warnings.filter(w => w.type === 'warn_duplicate_quality')
    expect(dupes.length).toBe(1)
    expect(dupes[0]?.path).toBe('Show (2020) — Season 1')
    expect(dupes[0]?.issue).toMatch(/Season 1 has duplicate HD copies in 2 folders: HD, Other HD/)
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('fires for {HD, Other HD} alone — a single-tier set the old check skipped', () => {
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        'Other HD': { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(true)
  })

  it('does NOT fire when different seasons sit in same-tier folders', () => {
    // Per-season scope: each season sees exactly one category, so S01 in HD/
    // and S02 in Other HD/ is a split library, not a duplicate.
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        'Other HD': { 'Show (2020)': { 'Season 02': { 'Show (2020) - S02E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
  })

  it('orders the bucket by quality (UHD, HD, SD), alphabetically within each tier', () => {
    const result = runShowsScan({
      spec: {
        UHD: { 'Zulu (2000)': { 'Season 01': { 'Zulu (2000) - S01E01.mp4': '' } } },
        'Other UHD': { 'Zulu (2000)': { 'Season 01': { 'Zulu (2000) - S01E01.mp4': '' } } },
        SD: { 'Alpha (2002)': { 'Season 01': { 'Alpha (2002) - S01E01.mp4': '' } } },
        'Other SD': { 'Alpha (2002)': { 'Season 01': { 'Alpha (2002) - S01E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'UHD' }, { name: 'Other UHD' }, { name: 'SD' }, { name: 'Other SD' }],
      },
    })
    const bucket = result.grouped['warn_duplicate_quality'] ?? []
    expect(bucket.map(r => r.path)).toEqual(['Zulu (2000) — Season 1', 'Alpha (2002) — Season 1'])
  })

  it('is not silenceable via acceptable_quality_combos', () => {
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        'Other HD': { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['HD'], ['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(true)
  })

  it('silenced when the toggle is false, leaving warn_multi_quality intact', () => {
    const result = runShowsScan({
      spec: {
        HD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        'Other HD': { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
        SD: { 'Show (2020)': { 'Season 01': { 'Show (2020) - S01E01.mp4': '' } } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }, { name: 'SD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
        checks: { ...defaultShowsRules.checks, warn_duplicate_quality: false },
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(true)
  })
})

describe('shows module — categories integration', () => {
  it('uses synthetic "default" category when none configured', () => {
    const result = runShowsScan({
      spec: {
        'Show (2020)': {
          'Season 01': { 'Show (2020) - S01E01.mp4': '' },
        },
      },
      rules: { categories: [] },
    })
    expect(result.output[0]?.seasons[0]?.versions[0]?.category).toBe('default')
  })
})
