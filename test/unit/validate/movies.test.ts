import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { validateMovies, movieDurationKey, type MovieDurations } from '../../../src/validate/movies'
import { defaultMoviesRules, type MoviesRules } from '../../../src/core/rules/movies'
import { JsonCache } from '../../../src/validate/cache'
import { WarningCollector, type MovieOutput } from '../../../src/core/types'
import type {
  ResolvedSearch,
  TmdbMovieDetails,
  TmdbMovieSearchResult,
} from '../../../src/validate/types'
import { TmdbClient } from '../../../src/validate/tmdb'

/**
 * Build an in-memory JsonCache that doesn't read from disk. We pass a
 * non-existent path so load() short-circuits, then set entries directly.
 */
function memoryCache<T>(seed: Record<string, T> = {}): JsonCache<T> {
  const cache = new JsonCache<T>('/dev/null-' + Math.random().toString(36))
  for (const [k, v] of Object.entries(seed)) cache.set(k, v)
  return cache
}

/** Minimal MovieOutput for validate input — versions is unused here. */
function movie(title: string, year: number, edition: string | null = null): MovieOutput {
  return { title, year, edition, versions: [] }
}

/**
 * Build a mock TmdbClient that returns canned responses. Lets us drive
 * validateMovies through every confidence path without hitting the network.
 */
function mockClient(opts: {
  searchResults?: TmdbMovieSearchResult[]
  details?: Record<number, TmdbMovieDetails>
  searchFails?: boolean
}): TmdbClient {
  return {
    searchMovie: vi.fn(async () => {
      if (opts.searchFails) throw new Error('mock failure')
      return opts.searchResults ?? []
    }),
    getMovie: vi.fn(async (id: number) => {
      const d = opts.details?.[id]
      if (!d) throw new Error('not found')
      return d
    }),
    get totalRequests() {
      return 0
    },
  } as unknown as TmdbClient
}

describe('validateMovies — confidence scoring', () => {
  let warnings: WarningCollector
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnings = new WarningCollector()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('resolves "high" confidence on exact title + exact year', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1994-05-13',
          popularity: 50,
        },
      ],
      details: {
        100: { id: 100, title: 'The Crow', original_title: 'The Crow', release_date: '1994-05-13' },
      },
    })

    const result = await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('high')
    expect(result[0]?.tmdb_id).toBe(100)
    expect(result[0]?.tmdb_title).toBe('The Crow')
    expect(result[0]?.tmdb_year).toBe(1994)
  })

  it('resolves "medium" confidence when year is off by 1', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1993-12-01', // off by 1
          popularity: 50,
        },
      ],
      details: {
        100: { id: 100, title: 'The Crow', original_title: 'The Crow', release_date: '1993-12-01' },
      },
    })

    const result = await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('medium')
  })

  it('resolves "medium" via the loose tier when a colon was rendered as " - "', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 425909,
          title: 'Ghostbusters: Afterlife',
          original_title: 'Ghostbusters: Afterlife',
          release_date: '2021-11-18',
          popularity: 20,
        },
      ],
      details: {
        425909: {
          id: 425909,
          title: 'Ghostbusters: Afterlife',
          original_title: 'Ghostbusters: Afterlife',
          release_date: '2021-11-18',
        },
      },
    })

    const result = await validateMovies(
      [movie('Ghostbusters - Afterlife', 2021)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    // 90 (loose title) + 50 (exact year) = 140 → medium, and no no-match warning.
    expect(result[0]?.confidence).toBe('medium')
    expect(result[0]?.tmdb_id).toBe(425909)
    expect(warnings.all().filter(w => w.type === 'warn_tmdb_no_match')).toHaveLength(0)
  })

  it('keeps "high" for a slash title the strict tier already handled', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 754,
          title: 'Face/Off',
          original_title: 'Face/Off',
          release_date: '1997-06-27',
          popularity: 17.8,
        },
      ],
      details: {
        754: {
          id: 754,
          title: 'Face/Off',
          original_title: 'Face/Off',
          release_date: '1997-06-27',
        },
      },
    })

    const result = await validateMovies(
      [movie('FaceOff', 1997)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('high')
    expect(result[0]?.tmdb_id).toBe(754)
  })

  it('still resolves "none" when the title genuinely differs', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 11418,
          title: 'Halloween H20: 20 Years Later',
          original_title: 'Halloween H20: 20 Years Later',
          release_date: '1998-08-05',
          popularity: 12,
        },
      ],
    })

    const result = await validateMovies(
      [movie('Halloween H2o - 20 Years Later', 1998)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    // "H2o" vs "H20" is a real folder typo — the loose tier must not paper over it.
    expect(result[0]?.confidence).toBe('none')
    expect(result[0]?.tmdb_id).toBeNull()
  })

  it('resolves "low" confidence for partial title match', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          title: 'Random Adventure',
          original_title: 'Random Adventure',
          release_date: '1994-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          title: 'Random Adventure',
          original_title: 'Random Adventure',
          release_date: '1994-01-01',
        },
      },
    })

    const result = await validateMovies(
      [movie('Adventure', 1994)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('low')
  })

  it('resolves "none" with no candidates', async () => {
    const client = mockClient({ searchResults: [] })

    const result = await validateMovies(
      [movie('Bogus Title', 2020)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('none')
    expect(result[0]?.tmdb_id).toBeNull()
  })

  it('handles a search exception as confidence "none" without crashing', async () => {
    const client = mockClient({ searchFails: true })

    const result = await validateMovies(
      [movie('X', 2000)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('none')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Search failed/))
  })

  it('scores a space-prefix match (subtitle missing) at +60 title points', async () => {
    // TMDB title prefixes our title with a space + extra words. With exact
    // year, score = 60 (prefix) + 50 (year) = 110 → "medium".
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'Star Wars Episode IV',
          original_title: 'Star Wars Episode IV',
          release_date: '1977-05-25',
          popularity: 50,
        },
      ],
      details: {
        1: {
          id: 1,
          title: 'Star Wars Episode IV',
          original_title: 'Star Wars Episode IV',
          release_date: '1977-05-25',
        },
      },
    })

    const result = await validateMovies(
      [movie('Star Wars', 1977)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('medium')
  })

  it('picks the more popular movie when scores tie', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'Heat',
          original_title: 'Heat',
          release_date: '1995-01-01',
          popularity: 5,
        },
        {
          id: 2,
          title: 'Heat',
          original_title: 'Heat',
          release_date: '1995-01-01',
          popularity: 100,
        },
      ],
      details: {
        1: { id: 1, title: 'Heat', original_title: 'Heat', release_date: '1995-01-01' },
        2: { id: 2, title: 'Heat', original_title: 'Heat', release_date: '1995-01-01' },
      },
    })

    const result = await validateMovies(
      [movie('Heat', 1995)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.tmdb_id).toBe(2) // the more popular one
  })
})

describe('validateMovies — warnings', () => {
  let warnings: WarningCollector

  beforeEach(() => {
    warnings = new WarningCollector()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('emits warn_tmdb_no_match when nothing matches', async () => {
    const client = mockClient({ searchResults: [] })
    await validateMovies(
      [movie('Missing', 2020)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().some(w => w.issue.match(/TMDB has nothing matching/))).toBe(true)
  })

  it('emits warn_tmdb_low_confidence when the best match is low', async () => {
    // Substring match (+30 title) + exact year (+50) = 80, which lands in
    // "low" (>= 60, < 110).
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'The Big Adventure',
          original_title: 'The Big Adventure',
          release_date: '2020-01-01',
          popularity: 1,
        },
      ],
      details: {
        1: {
          id: 1,
          title: 'The Big Adventure',
          original_title: 'The Big Adventure',
          release_date: '2020-01-01',
        },
      },
    })
    await validateMovies(
      [movie('Adventure', 2020)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().some(w => w.issue.match(/below the confidence threshold/i))).toBe(true)
  })

  it('emits warn_tmdb_year_mismatch when TMDB year differs from folder', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1994-05-13',
          popularity: 50,
        },
      ],
      details: {
        1: { id: 1, title: 'The Crow', original_title: 'The Crow', release_date: '1994-05-13' },
      },
    })
    await validateMovies(
      [movie('The Crow', 1993)], // local says 1993, TMDB says 1994
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().some(w => w.issue.match(/Folder says \d{4}, TMDB says/i))).toBe(true)
  })

  it('emits warn_tmdb_title_canonical when the folder title differs from TMDB filename-safe form', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1994-05-13',
          popularity: 50,
        },
      ],
      details: {
        1: { id: 1, title: 'The Crow', original_title: 'The Crow', release_date: '1994-05-13' },
      },
    })
    await validateMovies(
      [movie('the crow', 1994)], // local has lowercase; TMDB has Title Case
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().some(w => w.issue.match(/filename-safe form is/i))).toBe(true)
  })

  it('warn_tmdb_low_confidence includes Alternatives: text when alternate candidates are available', async () => {
    // Search returns two candidates. The best is low-confidence (partial title
    // match) and the runner-up has details in the cache, so the warning text
    // ends with the "Alternatives: ..." sentence.
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'The Big Adventure',
          original_title: 'The Big Adventure',
          release_date: '2020-01-01',
          popularity: 100, // wins ranking
        },
        {
          id: 2,
          title: 'Adventure Time',
          original_title: 'Adventure Time',
          release_date: '2010-01-01',
          popularity: 5,
        },
      ],
      details: {
        1: {
          id: 1,
          title: 'The Big Adventure',
          original_title: 'The Big Adventure',
          release_date: '2020-01-01',
        },
      },
    })
    const detailsCache = memoryCache<TmdbMovieDetails>({
      '2': {
        id: 2,
        title: 'Adventure Time',
        original_title: 'Adventure Time',
        release_date: '2010-01-01',
      },
    })

    await validateMovies(
      [movie('Adventure', 2020)],
      defaultMoviesRules,
      client,
      memoryCache(),
      detailsCache,
      warnings
    )

    const lowWarn = warnings.all().find(w => w.issue.match(/below the confidence threshold/i))
    expect(lowWarn?.issue).toMatch(/Alternatives:/)
    expect(lowWarn?.issue).toContain("'Adventure Time'")
  })

  it('silences warnings when toggles are false', async () => {
    const client = mockClient({ searchResults: [] })
    const rules: MoviesRules = {
      ...defaultMoviesRules,
      checks: { ...defaultMoviesRules.checks, warn_tmdb_no_match: false },
    }
    await validateMovies(
      [movie('Missing', 2020)],
      rules,
      client,
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all()).toEqual([])
  })
})

describe('validateMovies — caching', () => {
  it('serves cached search results without calling TMDB', async () => {
    const client = mockClient({ searchResults: [] })
    const searchCache = memoryCache<ResolvedSearch>({
      'movie|the crow|1994': { best_id: null, confidence: 'high', candidates: [] },
    })

    await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      client,
      searchCache,
      memoryCache(),
      new WarningCollector()
    )

    expect((client.searchMovie as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('re-queries TMDB when the cached verdict is "none"', async () => {
    // A cached no-match is never final: TMDB's search index changes, which is
    // exactly how "Face/Off" stayed a false no-match across many runs.
    const client = mockClient({
      searchResults: [
        {
          id: 754,
          title: 'Face/Off',
          original_title: 'Face/Off',
          release_date: '1997-06-27',
          popularity: 17.8,
        },
      ],
      details: {
        754: {
          id: 754,
          title: 'Face/Off',
          original_title: 'Face/Off',
          release_date: '1997-06-27',
        },
      },
    })
    const searchCache = memoryCache<ResolvedSearch>({
      'movie|faceoff|1997': { best_id: null, confidence: 'none', candidates: [59091] },
    })

    const result = await validateMovies(
      [movie('FaceOff', 1997)],
      defaultMoviesRules,
      client,
      searchCache,
      memoryCache(),
      new WarningCollector()
    )

    expect((client.searchMovie as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(result[0]?.confidence).toBe('high')
    expect(searchCache.get('movie|faceoff|1997')?.best_id).toBe(754)
  })

  it('re-queries TMDB when the cached verdict is "low"', async () => {
    const client = mockClient({ searchResults: [] })
    const searchCache = memoryCache<ResolvedSearch>({
      'movie|the crow|1994': { best_id: 100, confidence: 'low', candidates: [100] },
    })

    await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      client,
      searchCache,
      memoryCache(),
      new WarningCollector()
    )

    expect((client.searchMovie as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('serves cached "medium" verdicts without calling TMDB', async () => {
    const client = mockClient({ searchResults: [] })
    const searchCache = memoryCache<ResolvedSearch>({
      'movie|the crow|1994': { best_id: null, confidence: 'medium', candidates: [] },
    })

    await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      client,
      searchCache,
      memoryCache(),
      new WarningCollector()
    )

    expect((client.searchMovie as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('reports progress through the callback', async () => {
    const client = mockClient({ searchResults: [] })
    const progress = vi.fn()

    await validateMovies(
      [movie('A', 2020), movie('B', 2021)],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      new WarningCollector(),
      undefined,
      progress
    )

    expect(progress).toHaveBeenCalledWith(1, 2, 0)
    expect(progress).toHaveBeenCalledWith(2, 2, 0)
  })

  it('collects alternates from details cache for review', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          title: 'Heat',
          original_title: 'Heat',
          release_date: '1995-01-01',
          popularity: 100,
        },
        {
          id: 2,
          title: 'Heat',
          original_title: 'Heat',
          release_date: '1986-01-01',
          popularity: 5,
        },
      ],
      details: {
        1: { id: 1, title: 'Heat', original_title: 'Heat', release_date: '1995-01-01' },
        2: { id: 2, title: 'Heat (Old)', original_title: 'Heat', release_date: '1986-01-01' },
      },
    })
    const detailsCache = memoryCache<TmdbMovieDetails>({
      '2': { id: 2, title: 'Heat (Old)', original_title: 'Heat', release_date: '1986-01-01' },
    })

    const result = await validateMovies(
      [movie('Heat', 1995)],
      defaultMoviesRules,
      client,
      memoryCache(),
      detailsCache,
      new WarningCollector()
    )

    expect(result[0]?.alternatives).toEqual([{ id: 2, title: 'Heat (Old)', year: 1986 }])
  })
})

describe('validateMovies — warn_tmdb_runtime_mismatch', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** A client that resolves "The Crow" (1994) to a TMDB record of `runtime`. */
  function runtimeClient(runtime: number | null): TmdbClient {
    return mockClient({
      searchResults: [
        {
          id: 100,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1994-05-13',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          title: 'The Crow',
          original_title: 'The Crow',
          release_date: '1994-05-13',
          runtime,
        },
      },
    })
  }

  /** Probe durations for one file of The Crow, given a length in minutes. */
  function durationsOf(minutes: number): MovieDurations {
    return new Map([
      [
        movieDurationKey('The Crow', 1994, null),
        [{ path: 'HD/The Crow (1994)/The Crow (1994).mp4', duration_seconds: minutes * 60 }],
      ],
    ])
  }

  async function run(opts: {
    tmdbRuntime: number | null
    localMinutes: number
    rules?: Partial<MoviesRules>
    durations?: MovieDurations
    /** Build the collector with an ignore list, so rows carry a suggestion. */
    ignoreList?: boolean
  }) {
    const warnings = opts.ignoreList
      ? new WarningCollector({ mediaType: 'movies', entries: [] })
      : new WarningCollector()
    await validateMovies(
      [movie('The Crow', 1994)],
      { ...defaultMoviesRules, ...opts.rules },
      runtimeClient(opts.tmdbRuntime),
      memoryCache(),
      memoryCache(),
      warnings,
      opts.durations ?? durationsOf(opts.localMinutes)
    )
    return warnings.all().filter(w => w.type === 'warn_tmdb_runtime_mismatch')
  }

  it('fires when the file is far shorter than TMDB (truncated encode)', async () => {
    const hits = await run({ tmdbRuntime: 102, localMinutes: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.issue).toMatch(/File runs 5m, TMDB says 'The Crow' runs 1h 42m/)
    expect(hits[0]?.issue).toMatch(/95% shorter/)
    expect(hits[0]?.path).toBe('HD/The Crow (1994)/The Crow (1994).mp4')
  })

  it('fires when the file is far longer than TMDB (wrong match or concatenated)', async () => {
    const hits = await run({ tmdbRuntime: 5, localMinutes: 115 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.issue).toMatch(/longer/)
  })

  it('stays silent inside the tolerance band', async () => {
    // 90 local vs 102 TMDB is ~12% off — a different cut, not a problem.
    expect(await run({ tmdbRuntime: 102, localMinutes: 90 })).toHaveLength(0)
  })

  it('stays silent for a genuine short film whose runtime TMDB agrees with', async () => {
    // The case warn_short_duration cannot distinguish: 2m local, 2m on TMDB.
    expect(await run({ tmdbRuntime: 2, localMinutes: 2 })).toHaveLength(0)
  })

  it('fires exactly outside, not at, the tolerance boundary', async () => {
    // tolerance 50% => drift must EXCEED 0.5. 50 vs 100 is exactly 50%.
    expect(await run({ tmdbRuntime: 100, localMinutes: 50 })).toHaveLength(0)
    expect(await run({ tmdbRuntime: 100, localMinutes: 49 })).toHaveLength(1)
  })

  it('respects a custom runtime_tolerance_percent', async () => {
    const opts = { tmdbRuntime: 100, localMinutes: 70 } // 30% off
    expect(await run({ ...opts, rules: { runtime_tolerance_percent: 50 } })).toHaveLength(0)
    expect(await run({ ...opts, rules: { runtime_tolerance_percent: 20 } })).toHaveLength(1)
  })

  it('is disabled by runtime_tolerance_percent: 0', async () => {
    const hits = await run({
      tmdbRuntime: 102,
      localMinutes: 5,
      rules: { runtime_tolerance_percent: 0 },
    })
    expect(hits).toHaveLength(0)
  })

  it('is disabled by the check toggle', async () => {
    const hits = await run({
      tmdbRuntime: 102,
      localMinutes: 5,
      rules: {
        checks: { ...defaultMoviesRules.checks, warn_tmdb_runtime_mismatch: false },
      },
    })
    expect(hits).toHaveLength(0)
  })

  it('stays silent when TMDB has no runtime recorded', async () => {
    expect(await run({ tmdbRuntime: null, localMinutes: 5 })).toHaveLength(0)
    // TMDB uses 0 for "nobody filled this in" — not a zero-length film.
    expect(await run({ tmdbRuntime: 0, localMinutes: 5 })).toHaveLength(0)
  })

  it('stays silent when no probe durations were supplied', async () => {
    const warnings = new WarningCollector()
    await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      runtimeClient(102),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().filter(w => w.type === 'warn_tmdb_runtime_mismatch')).toHaveLength(0)
  })

  it('warns per file, so one truncated version does not implicate the others', async () => {
    const durations: MovieDurations = new Map([
      [
        movieDurationKey('The Crow', 1994, null),
        [
          { path: 'UHD/The Crow (1994)/The Crow (1994).mp4', duration_seconds: 102 * 60 },
          { path: 'HD/The Crow (1994)/The Crow (1994).mp4', duration_seconds: 5 * 60 },
        ],
      ],
    ])
    const hits = await run({ tmdbRuntime: 102, localMinutes: 0, durations })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe('HD/The Crow (1994)/The Crow (1994).mp4')
  })

  // The check's `path` is what an ignore entry has to match, so it must stay a
  // real file path rather than a display label.
  it('anchors the warning at the offending file so the ignore list can reach it', async () => {
    const hits = await run({ tmdbRuntime: 102, localMinutes: 5, ignoreList: true })
    expect(hits[0]?.path).toBe('HD/The Crow (1994)/The Crow (1994).mp4')
  })

  it('does not fire when TMDB found no match at all', async () => {
    const warnings = new WarningCollector()
    await validateMovies(
      [movie('The Crow', 1994)],
      defaultMoviesRules,
      mockClient({ searchResults: [] }),
      memoryCache(),
      memoryCache(),
      warnings,
      durationsOf(5)
    )
    expect(warnings.all().filter(w => w.type === 'warn_tmdb_runtime_mismatch')).toHaveLength(0)
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })
})
