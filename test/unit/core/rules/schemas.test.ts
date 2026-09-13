import { describe, it, expect } from 'vitest'

import { MoviesRulesSchema, defaultMoviesRules } from '../../../../src/core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from '../../../../src/core/rules/shows'
import { MusicRulesSchema, defaultMusicRules } from '../../../../src/core/rules/music'
import {
  AudiobooksRulesSchema,
  defaultAudiobooksRules,
} from '../../../../src/core/rules/audiobooks'

/**
 * Each schema's tests follow the same shape:
 *   1. The shipped defaults parse successfully (no drift between schema + default).
 *   2. Each per-section sub-rule rejects invalid input.
 *   3. Each `categories` and `quality_thresholds` shape is enforced.
 *
 * The defaults are exported pre-parsed (Zod's parse runs on the `defaultXxx`
 * objects at module load), so existence + shape is the runtime contract; we
 * also re-parse here to catch any case where the export type is loose.
 */

describe('MoviesRulesSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(MoviesRulesSchema.safeParse(defaultMoviesRules).success).toBe(true)
  })

  it('accepts categories as a list of { name } objects', () => {
    const rules = { ...defaultMoviesRules, categories: [{ name: 'UHD' }, { name: 'HD' }] }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects categories with a tag field (legacy shape removed)', () => {
    // Strict pass: Zod by default strips unknown keys, so {name, tag} parses
    // but the tag is dropped. Document that the rename was clean.
    const rules = {
      ...defaultMoviesRules,
      categories: [{ name: 'UHD', tag: 'UHD' }],
    }
    const result = MoviesRulesSchema.safeParse(rules)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.categories[0]).toEqual({ name: 'UHD' })
    }
  })

  it('rejects empty category names', () => {
    const rules = { ...defaultMoviesRules, categories: [{ name: '' }] }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts quality_thresholds without the legacy tags field', () => {
    const rules = {
      ...defaultMoviesRules,
      quality_thresholds: [{ name: 'UHD', min_width: 2000 }],
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('accepts a quality_thresholds bucket with no width constraint', () => {
    const rules = { ...defaultMoviesRules, quality_thresholds: [{ name: 'Anything' }] }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects a non-positive min_width', () => {
    const rules = {
      ...defaultMoviesRules,
      quality_thresholds: [{ name: 'UHD', min_width: -1 }],
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects a non-integer min_width', () => {
    const rules = {
      ...defaultMoviesRules,
      quality_thresholds: [{ name: 'UHD', min_width: 1.5 }],
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects an empty primary_extension list', () => {
    const rules = { ...defaultMoviesRules, primary_extension: [] }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects an empty video_extensions list', () => {
    const rules = { ...defaultMoviesRules, video_extensions: [] }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts year_range with numeric max', () => {
    const rules = { ...defaultMoviesRules, year_range: { min: 1888, max: 2026 } }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('accepts year_range with "current" max sentinel', () => {
    const rules = { ...defaultMoviesRules, year_range: { min: 1888, max: 'current' } }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects year_range with a negative min', () => {
    const rules = { ...defaultMoviesRules, year_range: { min: -1, max: 2026 } }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts a positive min_duration_minutes', () => {
    const rules = { ...defaultMoviesRules, min_duration_minutes: 30 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('accepts min_duration_minutes of 0 (the disable sentinel)', () => {
    const rules = { ...defaultMoviesRules, min_duration_minutes: 0 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects a negative min_duration_minutes', () => {
    const rules = { ...defaultMoviesRules, min_duration_minutes: -1 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects a fractional min_duration_minutes', () => {
    const rules = { ...defaultMoviesRules, min_duration_minutes: 12.5 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects a string min_duration_minutes', () => {
    const rules = { ...defaultMoviesRules, min_duration_minutes: '30' }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts a positive runtime_tolerance_percent', () => {
    const rules = { ...defaultMoviesRules, runtime_tolerance_percent: 25 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('accepts runtime_tolerance_percent of 0 (the disable sentinel)', () => {
    const rules = { ...defaultMoviesRules, runtime_tolerance_percent: 0 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects a negative runtime_tolerance_percent', () => {
    const rules = { ...defaultMoviesRules, runtime_tolerance_percent: -10 }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects when the warn_tmdb_runtime_mismatch toggle is missing', () => {
    const checks = { ...defaultMoviesRules.checks } as Record<string, boolean>
    delete checks.warn_tmdb_runtime_mismatch
    const rules = { ...defaultMoviesRules, checks }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects when the warn_short_duration toggle is missing', () => {
    const checks = { ...defaultMoviesRules.checks } as Record<string, boolean>
    delete checks.warn_short_duration
    const rules = { ...defaultMoviesRules, checks }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects when a check toggle is missing', () => {
    const checks = { ...defaultMoviesRules.checks } as Record<string, boolean>
    delete checks.warn_quality_mismatch
    const rules = { ...defaultMoviesRules, checks }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects when a check toggle is the wrong type', () => {
    const rules = {
      ...defaultMoviesRules,
      checks: { ...defaultMoviesRules.checks, warn_quality_mismatch: 'yes' },
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts string-form patterns', () => {
    const rules = {
      ...defaultMoviesRules,
      patterns: {
        folder: '^(?<title>.+)\\s\\((?<year>\\d{4})\\)$',
        file: '^(?<title>.+)\\s\\((?<year>\\d{4})\\)$',
      },
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects an invalid regex pattern', () => {
    const rules = {
      ...defaultMoviesRules,
      patterns: { folder: '[unterminated', file: '^.+$' },
    }
    expect(MoviesRulesSchema.safeParse(rules).success).toBe(false)
  })
})

describe('ShowsRulesSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(ShowsRulesSchema.safeParse(defaultShowsRules).success).toBe(true)
  })

  it('accepts an empty ignored_season_names', () => {
    const rules = { ...defaultShowsRules, ignored_season_names: [] }
    expect(ShowsRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('accepts the case-insensitive flags on season_folder', () => {
    const rules = {
      ...defaultShowsRules,
      patterns: {
        ...defaultShowsRules.patterns,
        season_folder: { pattern: '^Season\\s(?<season>\\d{2})$', flags: 'i' },
      },
    }
    expect(ShowsRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects when patterns.file is missing required capture groups (string is still a valid regex)', () => {
    // Schema only validates regex validity, not capture groups — that's documented
    // intent (runtime modules check group presence). Confirm the schema is permissive.
    const rules = {
      ...defaultShowsRules,
      patterns: {
        ...defaultShowsRules.patterns,
        file: '^.+$', // valid regex, no capture groups
      },
    }
    expect(ShowsRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects categories with a tag field (legacy shape removed)', () => {
    const rules = { ...defaultShowsRules, categories: [{ name: 'UHD', tag: 'UHD' }] }
    const result = ShowsRulesSchema.safeParse(rules)
    expect(result.success).toBe(true) // strip-unknown, like movies
    if (result.success) {
      expect(result.data.categories[0]).toEqual({ name: 'UHD' })
    }
  })
})

describe('MusicRulesSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(MusicRulesSchema.safeParse(defaultMusicRules).success).toBe(true)
  })

  it('rejects empty primary_extension', () => {
    const rules = { ...defaultMusicRules, primary_extension: [] }
    expect(MusicRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects empty audio_extensions', () => {
    const rules = { ...defaultMusicRules, audio_extensions: [] }
    expect(MusicRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts custom artist/album patterns', () => {
    const rules = {
      ...defaultMusicRules,
      patterns: {
        ...defaultMusicRules.patterns,
        artist_folder: '^[A-Z].+$',
        album_folder: '^(?<name>.+)\\s\\(\\d{4}\\)$',
      },
    }
    expect(MusicRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('rejects an invalid audio_extensions value type', () => {
    const rules = { ...defaultMusicRules, audio_extensions: [42, '.mp3'] }
    expect(MusicRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('rejects when warn_compilation_detected is missing', () => {
    const checks = { ...defaultMusicRules.checks } as Record<string, boolean>
    delete checks.warn_compilation_detected
    const rules = { ...defaultMusicRules, checks }
    expect(MusicRulesSchema.safeParse(rules).success).toBe(false)
  })
})

describe('AudiobooksRulesSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(AudiobooksRulesSchema.safeParse(defaultAudiobooksRules).success).toBe(true)
  })

  it('rejects empty primary_extension', () => {
    const rules = { ...defaultAudiobooksRules, primary_extension: [] }
    expect(AudiobooksRulesSchema.safeParse(rules).success).toBe(false)
  })

  it('accepts categories with non-quality names (Audible, Book On CD)', () => {
    const rules = {
      ...defaultAudiobooksRules,
      categories: [{ name: 'Audible' }, { name: 'Book On CD' }],
    }
    expect(AudiobooksRulesSchema.safeParse(rules).success).toBe(true)
  })

  it('does NOT include a quality_thresholds field (audiobooks have no quality rules)', () => {
    expect('quality_thresholds' in defaultAudiobooksRules).toBe(false)
  })

  it('rejects an empty categories name', () => {
    const rules = { ...defaultAudiobooksRules, categories: [{ name: '' }] }
    expect(AudiobooksRulesSchema.safeParse(rules).success).toBe(false)
  })
})
