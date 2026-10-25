import { describe, it, expect, vi } from 'vitest'

import { JsonCache } from '../../../src/validate/cache'
import {
  cachedFetch,
  hasCredits,
  stripFilenameIllegalChars,
  normalizeTitle,
  normalizeTitleLoose,
  parseYear,
} from '../../../src/validate/helpers'

describe('cachedFetch', () => {
  type Details = { id: number; credits?: { cast: unknown[]; crew: unknown[] } }
  const credits = { cast: [], crew: [] }

  function cacheWith(seed: Record<string, Details>): JsonCache<Details> {
    const cache = new JsonCache<Details>('/dev/null-' + Math.random().toString(36))
    for (const [k, v] of Object.entries(seed)) cache.set(k, v)
    return cache
  }

  it('returns a complete cached entry without fetching', async () => {
    const fetch = vi.fn()
    const cache = cacheWith({ '1': { id: 1, credits: { ...credits } } })
    await cachedFetch(cache, '1', fetch, 'x', hasCredits)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('re-fetches an entry cached before its credits were requested', async () => {
    const fresh = { id: 1, credits: { ...credits } }
    const cache = cacheWith({ '1': { id: 1 } })
    await expect(cachedFetch(cache, '1', async () => fresh, 'x', hasCredits)).resolves.toBe(fresh)
    expect(cache.get('1')).toBe(fresh)
  })

  it('falls back to the incomplete entry when the re-fetch fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = { id: 1 }
    const cache = cacheWith({ '1': old })
    const failing = async (): Promise<Details> => {
      throw new Error('TMDB HTTP 500')
    }
    await expect(cachedFetch(cache, '1', failing, 'x', hasCredits)).resolves.toEqual(old)
    vi.restoreAllMocks()
  })
})

describe('stripFilenameIllegalChars', () => {
  it('strips Windows-illegal characters without replacement', () => {
    expect(stripFilenameIllegalChars('50/50')).toBe('5050')
    expect(stripFilenameIllegalChars('3:10 to Yuma')).toBe('310 to Yuma')
    expect(stripFilenameIllegalChars('M*A*S*H')).toBe('MASH')
  })

  it('strips all of < > : " | ? * \\ /', () => {
    expect(stripFilenameIllegalChars('<>:"|?*\\/')).toBe('')
  })

  it('preserves diacritics', () => {
    expect(stripFilenameIllegalChars('Amélie')).toBe('Amélie')
    expect(stripFilenameIllegalChars('WALL·E')).toBe('WALL·E')
  })

  it('preserves apostrophes, hyphens, and periods', () => {
    expect(stripFilenameIllegalChars("Schindler's List")).toBe("Schindler's List")
    expect(stripFilenameIllegalChars('Spider-Man')).toBe('Spider-Man')
    expect(stripFilenameIllegalChars('Mr. Robot')).toBe('Mr. Robot')
  })

  it('returns the input unchanged when no illegal characters present', () => {
    expect(stripFilenameIllegalChars('The Crow')).toBe('The Crow')
  })
})

describe('normalizeTitle', () => {
  it('strips illegal chars, lowercases, collapses whitespace, and trims', () => {
    expect(normalizeTitle('  The   Crow  ')).toBe('the crow')
    expect(normalizeTitle('Mission: Impossible')).toBe('mission impossible')
  })

  it('keeps diacritics intact (so Amelie != Amélie at the strict comparison)', () => {
    expect(normalizeTitle('Amelie')).toBe('amelie')
    expect(normalizeTitle('Amélie')).toBe('amélie')
    expect(normalizeTitle('Amelie')).not.toBe(normalizeTitle('Amélie'))
  })

  it('preserves apostrophes and dashes', () => {
    expect(normalizeTitle("Schindler's List")).toBe("schindler's list")
    expect(normalizeTitle('Spider-Man')).toBe('spider-man')
  })

  it('handles empty input', () => {
    expect(normalizeTitle('')).toBe('')
  })
})

describe('normalizeTitleLoose', () => {
  it('treats " - " as equivalent to a subtitle colon', () => {
    expect(normalizeTitleLoose('Ghostbusters - Afterlife')).toBe(
      normalizeTitleLoose('Ghostbusters: Afterlife')
    )
    expect(normalizeTitleLoose('Godzilla - King of the Monsters')).toBe(
      normalizeTitleLoose('Godzilla: King of the Monsters')
    )
  })

  it('treats & and "and" as equivalent', () => {
    expect(normalizeTitleLoose('Pain And Gain')).toBe(normalizeTitleLoose('Pain & Gain'))
    expect(normalizeTitleLoose('Iliza Shlesinger - Over & Over')).toBe(
      normalizeTitleLoose('Iliza Shlesinger: Over & Over')
    )
  })

  it('ignores incidental punctuation', () => {
    expect(normalizeTitleLoose('Good Morning Vietnam')).toBe(
      normalizeTitleLoose('Good Morning, Vietnam')
    )
    expect(normalizeTitleLoose('Whitney Cummings - Can I Touch It')).toBe(
      normalizeTitleLoose('Whitney Cummings: Can I Touch It?')
    )
  })

  it('leaves hyphenated words alone (only " - " between words collapses)', () => {
    expect(normalizeTitleLoose('Spider-Man')).toBe('spider-man')
    expect(normalizeTitleLoose('Spider-Man')).not.toBe(normalizeTitleLoose('Spider Man'))
  })

  it('does NOT bridge Face/Off — that is the strict tier’s job', () => {
    // The loose tier turns "/" into a separator, so it sees "face off". Only
    // the strict tier (which deletes the slash) matches the folder "FaceOff".
    expect(normalizeTitleLoose('Face/Off')).toBe('face off')
    expect(normalizeTitleLoose('Face/Off')).not.toBe(normalizeTitleLoose('FaceOff'))
    expect(normalizeTitle('Face/Off')).toBe(normalizeTitle('FaceOff'))
  })

  it('still separates genuinely different titles', () => {
    // "H2o" vs "H20" is a real typo in the folder name, not a rendering choice.
    expect(normalizeTitleLoose('Halloween H2o - 20 Years Later')).not.toBe(
      normalizeTitleLoose('Halloween H20: 20 Years Later')
    )
    expect(normalizeTitleLoose('Gone In 60 Seconds')).not.toBe(
      normalizeTitleLoose('Gone in Sixty Seconds')
    )
  })

  it('keeps diacritics and apostrophes (legal in filenames, so a real divergence)', () => {
    expect(normalizeTitleLoose('Amelie')).not.toBe(normalizeTitleLoose('Amélie'))
    expect(normalizeTitleLoose("Freddy's Dead - The Final Nightmare")).toBe(
      "freddy's dead the final nightmare"
    )
  })

  it('handles empty input', () => {
    expect(normalizeTitleLoose('')).toBe('')
  })
})

describe('parseYear', () => {
  it('parses the leading 4 digits of an ISO date string', () => {
    expect(parseYear('1994-05-13')).toBe(1994)
  })

  it('handles dates with only the year', () => {
    expect(parseYear('2020')).toBe(2020)
  })

  it('returns null for undefined', () => {
    expect(parseYear(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseYear('')).toBeNull()
  })

  it('returns null for too-short input', () => {
    expect(parseYear('199')).toBeNull()
  })

  it('returns null for non-numeric input', () => {
    expect(parseYear('TBD-DATE')).toBeNull()
  })
})
