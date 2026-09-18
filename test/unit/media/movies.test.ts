import { describe, it, expect, vi } from 'vitest'

import { createMoviesModule } from '../../../src/media/movies'
import { defaultMoviesRules, MoviesRules } from '../../../src/core/rules/movies'
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

/**
 * Helper: build a rules object with categories + quality_thresholds wired up,
 * then run the movies module against a fixture library and collect the result.
 */
function runMoviesScan(opts: {
  spec: DirSpec
  rules?: Partial<MoviesRules>
  probes?: Record<string, ReturnType<typeof fakeProbe>>
  /** Level-keyed ignore file contents, as `ignored/<drive>/movies.yaml` parses. */
  ignored?: Record<string, string[]>
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
  const root = buildLibrary(opts.spec, 'moasys-movies-')
  // Silence scan()'s [SKIP] logs for missing category folders.
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const module = createMoviesModule(rules)
  const warnings = new WarningCollector(parseIgnoreList(opts.ignored ?? {}, 'movies', 'test.yaml'))
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

describe('movies module — happy paths', () => {
  it('catalogs a movie in a single category with derived quality', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
      },
      probes: {
        'UHD/The Crow (1994)/The Crow (1994).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
      },
    })
    expect(result.output).toEqual([
      {
        title: 'The Crow',
        year: 1994,
        edition: null,
        versions: [{ category: 'UHD', quality: 'UHD' }],
      },
    ])
  })

  it('returns quality null when no probe data is available', () => {
    const result = runMoviesScan({
      spec: { HD: { 'Inception (2010)': { 'Inception (2010).mp4': '' } } },
    })
    expect(result.output[0]?.versions[0]).toEqual({ category: 'HD', quality: null })
  })

  it('emits one version per category for a movie that exists in multiple categories', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
        HD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
      },
      probes: {
        'UHD/The Crow (1994)/The Crow (1994).mp4': fakeProbe({
          video: { codec: 'hevc', width: 3840, height: 2160, frame_rate: 24 },
        }),
        'HD/The Crow (1994)/The Crow (1994).mp4': fakeProbe({
          video: { codec: 'h264', width: 1920, height: 1080, frame_rate: 24 },
        }),
      },
    })
    expect(result.output[0]?.versions).toEqual([
      { category: 'UHD', quality: 'UHD' },
      { category: 'HD', quality: 'HD' },
    ])
  })

  it('captures the edition tag', () => {
    const result = runMoviesScan({
      spec: {
        UHD: {
          'Blade Runner (1982)': {
            'Blade Runner (1982) {edition-Final Cut}.mp4': '',
          },
        },
      },
    })
    expect(result.output[0]?.edition).toBe('Final Cut')
  })

  it('serializes movies sorted by title then year then edition', () => {
    const result = runMoviesScan({
      spec: {
        UHD: {
          'Beta (2020)': { 'Beta (2020).mp4': '' },
          'Alpha (1999)': { 'Alpha (1999).mp4': '' },
          'Alpha (2010)': { 'Alpha (2010).mp4': '' },
          // Two same-title same-year movies that only differ by edition —
          // exercises the tertiary sort by edition.
          'Blade Runner (1982)': {
            'Blade Runner (1982) {edition-Theatrical}.mp4': '',
            'Blade Runner (1982) {edition-Final Cut}.mp4': '',
          },
        },
      },
    })
    expect(result.output.map(m => `${m.title}-${m.year}-${m.edition ?? ''}`)).toEqual([
      'Alpha-1999-',
      'Alpha-2010-',
      'Beta-2020-',
      'Blade Runner-1982-Final Cut',
      'Blade Runner-1982-Theatrical',
    ])
  })
})

describe('movies module — warnings', () => {
  it('warn_bad_file_name: file stem does not match the file pattern', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'crow.mp4': '' } },
      },
    })
    expect(
      result.warnings.some(w => w.issue.includes(`File name is not 'Movie Title (YEAR)'`))
    ).toBe(true)
  })

  it('warn_bad_file_name: silenced when toggle is false', () => {
    const result = runMoviesScan({
      spec: { UHD: { 'The Crow (1994)': { 'crow.mp4': '' } } },
      rules: {
        checks: { ...defaultMoviesRules.checks, warn_bad_file_name: false },
      },
    })
    expect(
      result.warnings.some(w => w.issue.includes(`File name is not 'Movie Title (YEAR)'`))
    ).toBe(false)
  })

  it('warn_bad_folder_name: folder stem does not match the folder pattern', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { CrowFolder: { 'The Crow (1994).mp4': '' } },
      },
    })
    expect(
      result.warnings.some(w => w.issue.includes(`Folder name is not 'Movie Title (YEAR)'`))
    ).toBe(true)
  })

  it('warn_title_mismatch: file title differs from folder title', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Sparrow (1994).mp4': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/File says .*, folder says /))).toBe(true)
  })

  it('warn_title_case: capitalization-only drift gets its own bucket', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The crow (1994).mp4': '' } },
      },
    })
    const types = result.warnings.map(w => w.type)
    expect(types).toContain('warn_title_case')
    expect(types).not.toContain('warn_title_mismatch')
  })

  it('warn_title_case: does not fire when the title matches exactly', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
      },
    })
    expect(result.warnings.map(w => w.type)).not.toContain('warn_title_case')
  })

  it('warn_year_mismatch: file year differs from folder year', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1995).mp4': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/File says \d{4}, folder says \d{4}/))).toBe(
      true
    )
  })

  it('warn_suspicious_year: year before 1888', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'Ancient Film (1500)': { 'Ancient Film (1500).mp4': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Year \d+ is outside/))).toBe(true)
  })

  it('warn_empty_edition: {edition-} tag with no value', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994) {edition-}.mp4': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/{edition-} has no value/))).toBe(true)
  })

  it('warn_duplicate_edition: two files in same folder parse to same edition', () => {
    // No-edition + empty-edition both collapse to null after the empty
    // treatment, so they share an edition key and trigger the duplicate.
    const result = runMoviesScan({
      spec: {
        UHD: {
          'The Crow (1994)': {
            'The Crow (1994).mp4': '',
            'The Crow (1994) {edition-}.mp4': '',
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/already claims/))).toBe(true)
  })

  it('warn_multi_quality: a `movies:` entry silences it despite the path having no category', () => {
    // The check emits a bare display name (`X (2000)`), so the old
    // path-prefix matcher could not be reached by any category-prefixed
    // entry — every entry in the real movies ignore file was one.
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        SD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: { acceptable_quality_combos: [['UHD', 'HD']] },
      ignored: { movies: ['X (2000)'] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('warn_multi_quality: an edition entry does not silence the plain movie', () => {
    // Matching is exact, so `X (2000)` and `X (2000) {edition-Director's Cut}`
    // stay separate — they are separate folders on disk.
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        SD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: { acceptable_quality_combos: [['UHD', 'HD']] },
      ignored: { movies: ["X (2000) {edition-Director's Cut}"] },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(true)
  })

  it('warn_multi_quality: same movie in two quality buckets not in acceptable_quality_combos', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        SD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']], // UHD/SD not acceptable
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Exists in multiple qualities/))).toBe(true)
  })

  it('warn_multi_quality: silenced when combo is in acceptable_quality_combos', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.issue.match(/multiple qualities/))).toBe(false)
  })

  it('warn_multi_quality: silenced for {Other UHD, Other HD} via the single [UHD, HD] combo', () => {
    // Auto-detect maps Other UHD → UHD and Other HD → HD, so this resolves
    // to qualities {UHD, HD} and matches the combo without needing a separate entry.
    const result = runMoviesScan({
      spec: {
        'Other UHD': { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'Other UHD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.issue.match(/multiple qualities/))).toBe(false)
  })

  it('warn_multi_quality: fires for {Other HD, SD} — quality set {HD, SD} not in combos', () => {
    // User's specific concern: Other HD (→ HD) + SD = qualities {HD, SD}.
    // Not in `[[UHD, HD]]` combo → fires.
    const result = runMoviesScan({
      spec: {
        'Other HD': { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
        SD: { 'The Crow (1994)': { 'The Crow (1994).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'Other HD' }, { name: 'SD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    const w = result.warnings.find(x => x.issue.match(/multiple qualities/))
    expect(w?.issue).toMatch(/HD, SD/) // canonical-order sort: HD before SD
  })

  it('warn_multi_quality: silenced when warn_multi_quality is off', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        SD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']],
        checks: { ...defaultMoviesRules.checks, warn_multi_quality: false },
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('warn_no_videos: folder has no video files', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'cover.jpg': '' } }, // only a sidecar
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Movie folder has no video files/))).toBe(true)
  })

  it('warn_non_primary: a non-primary file (.mkv when primary is .mp4)', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'The Crow (1994)': { 'The Crow (1994).mkv': '' } },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Non-.MP4/))).toBe(true)
  })

  it('warn_unexpected_entries: stray .txt at media folder root', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'notes.txt': '' },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected file/))).toBe(true)
  })

  it('warn_unexpected_entries: stray non-video, non-sidecar file inside a movie folder', () => {
    const result = runMoviesScan({
      spec: {
        UHD: {
          'The Crow (1994)': {
            'The Crow (1994).mp4': '',
            'random.zip': '', // non-video, non-sidecar — flagged
          },
        },
      },
    })
    expect(
      result.warnings.some(w => w.issue.match(/Unexpected file\(s\) in the movie folder/))
    ).toBe(true)
  })

  it('warn_loose_files: video file directly inside a category folder', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'stray.mp4': '' },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/loose video file/i))).toBe(true)
  })

  it('warn_extra_subfolders: nested folder inside a movie folder', () => {
    const result = runMoviesScan({
      spec: {
        UHD: {
          'The Crow (1994)': {
            'The Crow (1994).mp4': '',
            Extras: { 'bonus.mp4': '' },
          },
        },
      },
    })
    expect(result.warnings.some(w => w.issue.match(/Unexpected subfolder/))).toBe(true)
  })
})

describe('movies module — categories integration', () => {
  it('uses the synthetic "default" category when none configured', () => {
    const result = runMoviesScan({
      spec: { 'X (2000)': { 'X (2000).mp4': '' } },
      rules: { categories: [] },
    })
    expect(result.output[0]?.versions[0]?.category).toBe('default')
  })

  it('skips missing category folders silently', () => {
    // Configure UHD + HD + SD; only build UHD. No crash.
    const result = runMoviesScan({
      spec: { UHD: { 'X (2000)': { 'X (2000).mp4': '' } } },
    })
    expect(result.output.length).toBe(1)
  })
})

describe('movies module — warn_duplicate_quality', () => {
  it('fires for {UHD, HD, Other HD} while warn_multi_quality stays silent', () => {
    // The regression this check exists for. HD and Other HD both resolve to
    // tier HD, so the tier SET is {UHD, HD} — the whitelisted combo — and the
    // multi-quality check sees nothing wrong. The third file is a duplicate
    // only the cardinality check can see.
    const result = runMoviesScan({
      spec: {
        UHD: { 'Deadpool (2016)': { 'Deadpool (2016).mp4': '' } },
        HD: { 'Deadpool (2016)': { 'Deadpool (2016).mp4': '' } },
        'Other HD': { 'Deadpool (2016)': { 'Deadpool (2016).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'UHD' }, { name: 'HD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    const dupes = result.warnings.filter(w => w.type === 'warn_duplicate_quality')
    expect(dupes.length).toBe(1)
    expect(dupes[0]?.path).toBe('Deadpool (2016)')
    expect(dupes[0]?.issue).toMatch(/Duplicate HD copies in 2 folders: HD, Other HD/)
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(false)
  })

  it('fires for {HD, Other HD} alone — a single-tier set the old check skipped', () => {
    const result = runMoviesScan({
      spec: {
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
      },
    })
    const dupes = result.warnings.filter(w => w.type === 'warn_duplicate_quality')
    expect(dupes.length).toBe(1)
    expect(dupes[0]?.issue).toMatch(/Duplicate HD copies in 2 folders: HD, Other HD/)
  })

  it('reports one warning per duplicated tier when several tiers duplicate', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other UHD': { 'X (2000)': { 'X (2000).mp4': '' } },
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'UHD' }, { name: 'Other UHD' }, { name: 'HD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    const dupes = result.warnings.filter(w => w.type === 'warn_duplicate_quality')
    expect(dupes.length).toBe(2)
    // sortQualities puts UHD ahead of HD
    expect(dupes.map(d => d.issue)).toEqual([
      expect.stringMatching(/Duplicate UHD copies in 2 folders: UHD, Other UHD/),
      expect.stringMatching(/Duplicate HD copies in 2 folders: HD, Other HD/),
    ])
  })

  it('orders the bucket by quality (UHD, HD, SD), alphabetically within each tier', () => {
    // Zulu duplicates at UHD and Alpha at SD — path order alone would put
    // Alpha first. The sortKey groups by quality instead, so the worst
    // offenders read together at the top.
    const result = runMoviesScan({
      spec: {
        UHD: { 'Zulu (2000)': { 'Zulu (2000).mp4': '' } },
        'Other UHD': { 'Zulu (2000)': { 'Zulu (2000).mp4': '' } },
        HD: { 'Mike (2001)': { 'Mike (2001).mp4': '' } },
        'Other HD': { 'Mike (2001)': { 'Mike (2001).mp4': '' } },
        SD: { 'Alpha (2002)': { 'Alpha (2002).mp4': '' } },
        'Other SD': { 'Alpha (2002)': { 'Alpha (2002).mp4': '' } },
      },
      rules: {
        categories: [
          { name: 'UHD' },
          { name: 'Other UHD' },
          { name: 'HD' },
          { name: 'Other HD' },
          { name: 'SD' },
          { name: 'Other SD' },
        ],
      },
    })
    const bucket = result.grouped['warn_duplicate_quality']?.items ?? []
    expect(bucket.map(r => r.path)).toEqual(['Zulu (2000)', 'Mike (2001)', 'Alpha (2002)'])
  })

  it('does not fire for one copy per tier', () => {
    const result = runMoviesScan({
      spec: {
        UHD: { 'X (2000)': { 'X (2000).mp4': '' } },
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        acceptable_quality_combos: [['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
  })

  it('does not fire for general-tag categories, which each form their own tier', () => {
    const result = runMoviesScan({
      spec: {
        Kids: { 'X (2000)': { 'X (2000).mp4': '' } },
        Documentaries: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'Kids' }, { name: 'Documentaries' }],
        quality_thresholds: [],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
  })

  it('is not silenceable via acceptable_quality_combos', () => {
    // Even listing the exact tier set as acceptable leaves the duplicate
    // reported — combos describe tiers, not copy counts.
    const result = runMoviesScan({
      spec: {
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
        acceptable_quality_combos: [['HD'], ['UHD', 'HD']],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(true)
  })

  it('silenced when warn_duplicate_quality is off, leaving warn_multi_quality intact', () => {
    const result = runMoviesScan({
      spec: {
        'Other HD': { 'X (2000)': { 'X (2000).mp4': '' } },
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
        SD: { 'X (2000)': { 'X (2000).mp4': '' } },
      },
      rules: {
        categories: [{ name: 'Other HD' }, { name: 'HD' }, { name: 'SD' }],
        acceptable_quality_combos: [['UHD', 'HD']],
        checks: { ...defaultMoviesRules.checks, warn_duplicate_quality: false },
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
    expect(result.warnings.some(w => w.type === 'warn_multi_quality')).toBe(true)
  })

  it('scopes per edition — a UHD theatrical and an HD director’s cut are distinct records', () => {
    const result = runMoviesScan({
      spec: {
        HD: { 'X (2000)': { 'X (2000).mp4': '' } },
        'Other HD': { 'X (2000)': { "X (2000) {edition-Director's Cut}.mp4": '' } },
      },
      rules: {
        categories: [{ name: 'HD' }, { name: 'Other HD' }],
      },
    })
    expect(result.warnings.some(w => w.type === 'warn_duplicate_quality')).toBe(false)
  })
})
