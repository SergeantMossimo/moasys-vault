import { describe, it, expect } from 'vitest'

import {
  PatternSchema,
  CategorySchema,
  canonicalEpisodeCode,
  compilePattern,
  detectQuality,
  extractEpisodeCode,
  resolveCategories,
  sortQualities,
} from '../../../../src/core/rules/helpers'

describe('PatternSchema', () => {
  it('accepts a plain string and normalizes it to { pattern, flags: "" }', () => {
    const parsed = PatternSchema.parse('^abc$')
    expect(parsed).toEqual({ pattern: '^abc$', flags: '' })
  })

  it('accepts an object with pattern only', () => {
    const parsed = PatternSchema.parse({ pattern: '^abc$' })
    expect(parsed).toEqual({ pattern: '^abc$', flags: '' })
  })

  it('accepts an object with pattern and flags', () => {
    const parsed = PatternSchema.parse({ pattern: '^abc$', flags: 'i' })
    expect(parsed).toEqual({ pattern: '^abc$', flags: 'i' })
  })

  it('rejects an invalid regex string', () => {
    expect(() => PatternSchema.parse('[unterminated')).toThrow()
  })

  it('rejects invalid flag letters', () => {
    expect(() => PatternSchema.parse({ pattern: 'x', flags: 'q' })).toThrow()
  })

  it('accepts each valid flag letter', () => {
    for (const flag of ['d', 'g', 'i', 'm', 's', 'u', 'y']) {
      expect(() => PatternSchema.parse({ pattern: 'x', flags: flag })).not.toThrow()
    }
  })

  it('accepts combined flag letters', () => {
    const parsed = PatternSchema.parse({ pattern: 'x', flags: 'gim' })
    expect(parsed.flags).toBe('gim')
  })
})

describe('compilePattern', () => {
  it('produces a RegExp that matches its pattern', () => {
    const re = compilePattern({ pattern: '^abc$', flags: '' })
    expect(re.test('abc')).toBe(true)
    expect(re.test('xyz')).toBe(false)
  })

  it('respects the case-insensitive flag', () => {
    const re = compilePattern({ pattern: '^abc$', flags: 'i' })
    expect(re.test('ABC')).toBe(true)
  })

  it('preserves named capture groups', () => {
    const re = compilePattern({ pattern: '^(?<title>.+)$', flags: '' })
    const match = re.exec('Hello')
    expect(match?.groups?.title).toBe('Hello')
  })
})

describe('CategorySchema', () => {
  it('accepts a category with a name', () => {
    expect(CategorySchema.parse({ name: 'UHD' })).toEqual({ name: 'UHD' })
  })

  it('rejects a category with an empty name', () => {
    expect(() => CategorySchema.parse({ name: '' })).toThrow()
  })

  it('rejects a category missing the name field', () => {
    expect(() => CategorySchema.parse({})).toThrow()
  })
})

describe('detectQuality', () => {
  it('returns the keyword when the category name is exactly UHD/HD/SD', () => {
    expect(detectQuality('UHD')).toBe('UHD')
    expect(detectQuality('HD')).toBe('HD')
    expect(detectQuality('SD')).toBe('SD')
  })

  it('matches inside multi-word names with whole-word boundary', () => {
    expect(detectQuality('Other UHD')).toBe('UHD')
    expect(detectQuality('Other HD')).toBe('HD')
    expect(detectQuality('Other SD')).toBe('SD')
    expect(detectQuality("Director's Cut UHD")).toBe('UHD')
  })

  it('is case-insensitive', () => {
    expect(detectQuality('uhd')).toBe('UHD')
    expect(detectQuality('other hd')).toBe('HD')
    expect(detectQuality('OtHeR sD')).toBe('SD')
  })

  it('prefers UHD over HD when both could match (UHD-first ordering)', () => {
    // "UHD" alone — both `\bUHD\b` and `\bHD\b` could find substrings, but
    // word boundaries make `HD` not match inside `UHD`. Just verify UHD wins.
    expect(detectQuality('UHD')).toBe('UHD')
    // If a hypothetical name contained both, the iteration order should pick UHD.
    expect(detectQuality('UHD or HD edition')).toBe('UHD')
  })

  it('returns null when no whole-word keyword is present', () => {
    expect(detectQuality('USD')).toBeNull() // contains SD as substring but not whole-word
    expect(detectQuality('Standard')).toBeNull()
    expect(detectQuality('Standard Definition')).toBeNull()
    expect(detectQuality('Documentary')).toBeNull()
    expect(detectQuality('Music')).toBeNull()
    expect(detectQuality('Audible')).toBeNull()
    expect(detectQuality('Book On CD')).toBeNull()
  })

  it('respects word boundaries around hyphens, slashes, and parens', () => {
    expect(detectQuality('UHD-Remaster')).toBe('UHD')
    expect(detectQuality('Remaster (UHD)')).toBe('UHD')
    expect(detectQuality('HD/Other')).toBe('HD')
  })
})

describe('resolveCategories', () => {
  it('synthesizes a single root-walk entry when configured is empty', () => {
    expect(resolveCategories([])).toEqual([{ folderName: '', name: 'default', quality: null }])
  })

  it('detects quality from each configured category name', () => {
    expect(resolveCategories([{ name: 'UHD' }, { name: 'Other HD' }])).toEqual([
      { folderName: 'UHD', name: 'UHD', quality: 'UHD' },
      { folderName: 'Other HD', name: 'Other HD', quality: 'HD' },
    ])
  })

  it('assigns quality null to general-tag categories', () => {
    expect(resolveCategories([{ name: 'Music' }, { name: 'Audible' }])).toEqual([
      { folderName: 'Music', name: 'Music', quality: null },
      { folderName: 'Audible', name: 'Audible', quality: null },
    ])
  })

  it('preserves input order', () => {
    const result = resolveCategories([{ name: 'C' }, { name: 'A' }, { name: 'B' }])
    expect(result.map(r => r.name)).toEqual(['C', 'A', 'B'])
  })
})

describe('sortQualities', () => {
  it('orders the known vocabulary best-to-worst (UHD, HD, SD)', () => {
    expect(sortQualities(['SD', 'UHD', 'HD'])).toEqual(['UHD', 'HD', 'SD'])
  })

  it('puts unknown qualities AFTER all known ones, alphabetically among themselves', () => {
    expect(sortQualities(['Custom B', 'HD', 'Custom A', 'UHD'])).toEqual([
      'UHD',
      'HD',
      'Custom A',
      'Custom B',
    ])
  })

  it('falls back to alphabetical for two unknown qualities (both indexOf === -1)', () => {
    expect(sortQualities(['Zeta', 'Alpha', 'Beta'])).toEqual(['Alpha', 'Beta', 'Zeta'])
  })

  it('handles a set as input (any iterable)', () => {
    expect(sortQualities(new Set(['HD', 'UHD', 'SD']))).toEqual(['UHD', 'HD', 'SD'])
  })

  it('returns an empty array for an empty input', () => {
    expect(sortQualities([])).toEqual([])
  })
})

// ─────────────────────────────────────────────
// Episode code formatting
// ─────────────────────────────────────────────

describe('canonicalEpisodeCode', () => {
  const single = { seasonNumber: 1, episodeStart: 2, episodeEnd: 2 }
  const multi = { seasonNumber: 3, episodeStart: 1, episodeEnd: 2 }

  it('applies the configured letter case', () => {
    expect(canonicalEpisodeCode(single, 'lower')).toBe('s01e02')
    expect(canonicalEpisodeCode(single, 'upper')).toBe('S01E02')
  })

  it('spells out the letter on the multi-episode suffix', () => {
    // The bare `-02` form is ambiguous, so canonical always writes `-e02`.
    expect(canonicalEpisodeCode(multi, 'lower')).toBe('s03e01-e02')
    expect(canonicalEpisodeCode(multi, 'upper')).toBe('S03E01-E02')
  })

  it('zero-pads single-digit numbers', () => {
    expect(canonicalEpisodeCode({ seasonNumber: 0, episodeStart: 4, episodeEnd: 4 }, 'lower')).toBe(
      's00e04'
    )
  })
})

describe('extractEpisodeCode', () => {
  it('returns the code exactly as written, not a normalized form', () => {
    // warn_episode_code_case compares what the user typed, so parsing to
    // integers and back would defeat the entire check.
    expect(extractEpisodeCode('Dune Prophecy (2024) - S01e02', 2024)).toBe('S01e02')
    expect(extractEpisodeCode('MASH (1972) - s04e25', 1972)).toBe('s04e25')
    expect(extractEpisodeCode('Abbott Elementary (2021) - S03E01-E02', 2021)).toBe('S03E01-E02')
  })

  it('captures both multi-episode suffix forms', () => {
    expect(extractEpisodeCode('Show (2020) - s01e01-e02', 2020)).toBe('s01e01-e02')
    expect(extractEpisodeCode('Show (2020) - s01e01-02', 2020)).toBe('s01e01-02')
  })

  it('anchors on the year so a " - S.." inside the show title is not mistaken for the code', () => {
    expect(extractEpisodeCode('Star Trek - Voyager (1995) - s07e09-e10', 1995)).toBe('s07e09-e10')
  })

  it('ignores a trailing episode title', () => {
    expect(extractEpisodeCode('Barry (2018) - s02e05 - ronny lily', 2018)).toBe('s02e05')
  })

  it('returns null when there is no recognizable code', () => {
    expect(extractEpisodeCode('Barry (2018)', 2018)).toBeNull()
    expect(extractEpisodeCode('Barry (2018) - 205', 2018)).toBeNull()
    expect(extractEpisodeCode('Barry (2018) - s02e05', 1999)).toBeNull()
  })
})
