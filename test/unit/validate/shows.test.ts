import { describe, it, expect, beforeEach, vi } from 'vitest'

import { validateShows } from '../../../src/validate/shows'
import { defaultShowsRules, type ShowsRules } from '../../../src/core/rules/shows'
import { JsonCache } from '../../../src/validate/cache'
import { WarningCollector, type ShowOutput } from '../../../src/core/types'
import type {
  ResolvedSearch,
  TmdbShowDetails,
  TmdbShowSearchResult,
  TmdbSeasonDetails,
} from '../../../src/validate/types'
import { TmdbClient } from '../../../src/validate/tmdb'

function memoryCache<T>(seed: Record<string, T> = {}): JsonCache<T> {
  const cache = new JsonCache<T>('/dev/null-' + Math.random().toString(36))
  for (const [k, v] of Object.entries(seed)) cache.set(k, v)
  return cache
}

function show(
  title: string,
  year: number,
  seasons: ShowOutput['seasons'] = [],
  edition: string | null = null
): ShowOutput {
  return { title, year, edition, seasons }
}

function mockClient(opts: {
  searchResults?: TmdbShowSearchResult[]
  details?: Record<number, TmdbShowDetails>
  /** Keyed by `${showId}:${seasonNumber}` */
  seasons?: Record<string, TmdbSeasonDetails>
  searchFails?: boolean
}): TmdbClient {
  return {
    searchShow: vi.fn(async () => {
      if (opts.searchFails) throw new Error('mock failure')
      return opts.searchResults ?? []
    }),
    getShow: vi.fn(async (id: number) => {
      const d = opts.details?.[id]
      if (!d) throw new Error('not found')
      return d
    }),
    getShowSeason: vi.fn(async (showId: number, seasonNumber: number) => {
      const d = opts.seasons?.[`${showId}:${seasonNumber}`]
      if (!d) throw new Error('season not found')
      return d
    }),
    get totalRequests() {
      return 0
    },
  } as unknown as TmdbClient
}

describe('validateShows — confidence scoring', () => {
  let warnings: WarningCollector

  beforeEach(() => {
    warnings = new WarningCollector()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('resolves "high" on exact name + exact year', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Star Trek Enterprise',
          original_name: 'Star Trek Enterprise',
          first_air_date: '2001-09-26',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Star Trek Enterprise',
          original_name: 'Star Trek Enterprise',
          first_air_date: '2001-09-26',
          number_of_seasons: 4,
          number_of_episodes: 98,
          seasons: [{ season_number: 1, episode_count: 26, name: 'Season 1' }],
        },
      },
    })

    const result = await validateShows(
      [show('Star Trek Enterprise', 2001)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(result[0]?.confidence).toBe('high')
    expect(result[0]?.tmdb_first_air_year).toBe(2001)
  })

  it('resolves "medium" via the loose tier when a colon was rendered as " - "', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Star Trek: Enterprise',
          original_name: 'Star Trek: Enterprise',
          first_air_date: '2001-09-26',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Star Trek: Enterprise',
          original_name: 'Star Trek: Enterprise',
          first_air_date: '2001-09-26',
          number_of_seasons: 4,
          number_of_episodes: 98,
          seasons: [{ season_number: 1, episode_count: 26, name: 'Season 1' }],
        },
      },
    })

    const result = await validateShows(
      [show('Star Trek - Enterprise', 2001)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    // 90 (loose name) + 50 (exact year) = 140 → medium, no no-match warning.
    expect(result[0]?.confidence).toBe('medium')
    expect(result[0]?.tmdb_id).toBe(100)
    expect(warnings.all().filter(w => w.type === 'warn_tmdb_no_match')).toHaveLength(0)
  })

  it('re-queries TMDB when the cached verdict is "none"', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Star Trek: Enterprise',
          original_name: 'Star Trek: Enterprise',
          first_air_date: '2001-09-26',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Star Trek: Enterprise',
          original_name: 'Star Trek: Enterprise',
          first_air_date: '2001-09-26',
          number_of_seasons: 4,
          number_of_episodes: 98,
          seasons: [{ season_number: 1, episode_count: 26, name: 'Season 1' }],
        },
      },
    })
    const searchCache = memoryCache<ResolvedSearch>({
      'show|star trek - enterprise|2001': { best_id: null, confidence: 'none', candidates: [] },
    })

    const result = await validateShows(
      [show('Star Trek - Enterprise', 2001)],
      defaultShowsRules,
      client,
      searchCache,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect((client.searchShow as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(result[0]?.confidence).toBe('medium')
  })

  it('serves cached "high" verdicts without calling TMDB', async () => {
    const client = mockClient({ searchResults: [] })
    const searchCache = memoryCache<ResolvedSearch>({
      'show|star trek enterprise|2001': { best_id: null, confidence: 'high', candidates: [] },
    })

    await validateShows(
      [show('Star Trek Enterprise', 2001)],
      defaultShowsRules,
      client,
      searchCache,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect((client.searchShow as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('returns "none" when search has no candidates', async () => {
    const client = mockClient({ searchResults: [] })
    const result = await validateShows(
      [show('Made Up Show', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(result[0]?.confidence).toBe('none')
  })

  it('resolves "medium" via prefix match (subtitle missing) + exact year', async () => {
    // localTitle 'Friends' is a space-prefix of 'Friends Forever'.
    // prefix +60 + year exact +50 = 110 → medium.
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          name: 'Friends Forever',
          original_name: 'Friends Forever',
          first_air_date: '1994-09-22',
          popularity: 50,
        },
      ],
      details: {
        1: {
          id: 1,
          name: 'Friends Forever',
          original_name: 'Friends Forever',
          first_air_date: '1994-09-22',
          number_of_seasons: 1,
          number_of_episodes: 24,
          seasons: [],
        },
      },
    })
    const result = await validateShows(
      [show('Friends', 1994)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(result[0]?.confidence).toBe('medium')
  })

  it('resolves "low" via includes match + exact year', async () => {
    // substring +30 + year exact +50 = 80 → low.
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          name: 'The Big Adventure Show',
          original_name: 'The Big Adventure Show',
          first_air_date: '2020-01-01',
          popularity: 1,
        },
      ],
      details: {
        1: {
          id: 1,
          name: 'The Big Adventure Show',
          original_name: 'The Big Adventure Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 0,
          number_of_episodes: 0,
          seasons: [],
        },
      },
    })
    const result = await validateShows(
      [show('Adventure', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(result[0]?.confidence).toBe('low')
  })

  it('logs and falls back to "none" when search throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = mockClient({ searchFails: true })
    const result = await validateShows(
      [show('X', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(result[0]?.confidence).toBe('none')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Search failed/))
  })

  it('logs and continues when getShow throws for the matched ID', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 50,
        },
      ],
      details: {}, // getShow throws when id not in details
    })
    const result = await validateShows(
      [show('Show', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(result[0]?.confidence).toBe('high') // search still resolved
    expect(result[0]?.tmdb_title).toBeNull() // but details failed
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Details failed/))
  })

  it('collects alternate candidates from the details cache', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 100,
        },
        {
          id: 2,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2010-01-01',
          popularity: 5,
        },
      ],
      details: {
        1: {
          id: 1,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 0,
          number_of_episodes: 0,
          seasons: [],
        },
      },
    })
    const detailsCache = memoryCache<TmdbShowDetails>({
      '2': {
        id: 2,
        name: 'Older Show',
        original_name: 'Older Show',
        first_air_date: '2010-01-01',
        number_of_seasons: 0,
        number_of_episodes: 0,
        seasons: [],
      },
    })

    const result = await validateShows(
      [show('Show', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      detailsCache,
      memoryCache(),
      warnings
    )

    expect(result[0]?.alternatives).toEqual([{ id: 2, title: 'Older Show', year: 2010 }])
  })

  it('compares per-season episode counts to TMDB', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 2,
          number_of_episodes: 23,
          seasons: [
            { season_number: 1, episode_count: 13, name: 'Season 1' },
            { season_number: 2, episode_count: 10, name: 'Season 2' },
          ],
        },
      },
    })

    const result = await validateShows(
      [
        show('Show', 2020, [
          { season: '1', episode_count: 10, versions: [], episodes: [] }, // missing 3
          { season: '2', episode_count: 10, versions: [], episodes: [] }, // complete
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    const s1 = result[0]?.seasons.find(s => s.season === '1')
    expect(s1?.tmdb_episode_count).toBe(13)
    expect(s1?.missing).toBe(3)
  })
})

describe('validateShows — warnings', () => {
  let warnings: WarningCollector

  beforeEach(() => {
    warnings = new WarningCollector()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('emits warn_tmdb_no_match', async () => {
    const client = mockClient({ searchResults: [] })
    await validateShows(
      [show('Missing', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().some(w => w.issue.match(/TMDB has nothing matching/i))).toBe(true)
  })

  it('emits warn_tmdb_episode_count when a numeric season is short of TMDB', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 1,
          number_of_episodes: 13,
          seasons: [{ season_number: 1, episode_count: 13, name: 'Season 1' }],
        },
      },
    })

    await validateShows(
      [show('Show', 2020, [{ season: '1', episode_count: 10, versions: [], episodes: [] }])],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().some(w => w.issue.match(/10\/13 episodes per TMDB/i))).toBe(true)
  })

  /**
   * Two editions of one series are separate rows — Plex tracks them as
   * separate items — but they share a title+year, so the search cache serves
   * the second from the first and TMDB is queried once.
   */
  it('validates each edition, carries the tag, and searches TMDB once', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Spider-Noir',
          original_name: 'Spider-Noir',
          first_air_date: '2026-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Spider-Noir',
          original_name: 'Spider-Noir',
          first_air_date: '2026-01-01',
          number_of_seasons: 1,
          number_of_episodes: 8,
          seasons: [{ season_number: 1, episode_count: 8, name: 'Season 1' }],
        },
      },
    })

    const searchCache = memoryCache<ResolvedSearch>()
    const out = await validateShows(
      [
        show('Spider-Noir', 2026, [], 'True Hue Color'),
        show('Spider-Noir', 2026, [], 'Authentic Black and White'),
      ],
      defaultShowsRules,
      client,
      searchCache,
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(out.map(e => [e.edition, e.tmdb_id])).toEqual([
      ['True Hue Color', 100],
      ['Authentic Black and White', 100],
    ])
    expect(client.searchShow).toHaveBeenCalledTimes(1)
  })

  it('names the tagged folder in a warning path, so each edition can be ignored separately', async () => {
    const client = mockClient({ searchResults: [] })
    await validateShows(
      [
        show(
          'Spider-Noir',
          2026,
          [
            {
              season: '1',
              episode_count: 8,
              versions: [{ category: 'HD', quality: 'HD' }],
              episodes: [],
            },
          ],
          'True Hue Color'
        ),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all().map(w => w.path)).toEqual([
      'HD/Spider-Noir (2026) {edition-True Hue Color}',
    ])
  })

  it('uses a /-separated path so ignore-list prefix matching works across both checks', async () => {
    // Regression guard: validation paths must use `/` between show and
    // season/episode (not ` — `) so `ignored/shows.yaml` entries like
    // `HD/Some Show (2020)` silence the downstream warnings via prefix match.
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 1,
          number_of_episodes: 13,
          seasons: [{ season_number: 1, episode_count: 13, name: 'Season 1' }],
        },
      },
    })

    await validateShows(
      [show('Show', 2020, [{ season: '1', episode_count: 10, versions: [], episodes: [] }])],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    const w = warnings.all().find(x => x.type === 'warn_tmdb_episode_count')
    expect(w?.path).toBe('Show (2020)/Season 1')
    expect(w?.path).not.toContain(' — ')
  })

  it('skips episode-count warning for Specials season', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'Show',
          original_name: 'Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 0,
          number_of_episodes: 0,
          seasons: [{ season_number: 0, episode_count: 50, name: 'Specials' }],
        },
      },
    })

    await validateShows(
      [show('Show', 2020, [{ season: 'Specials', episode_count: 4, versions: [], episodes: [] }])],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().some(w => w.issue.match(/episodes per TMDB/i))).toBe(false)
  })

  it('emits warn_tmdb_title_canonical when folder differs from TMDB filename-safe form', async () => {
    // TMDB "The Crow" → safe form "The Crow". Folder "the crow" differs by
    // case, triggers the warning.
    const client = mockClient({
      searchResults: [
        {
          id: 100,
          name: 'The Crow',
          original_name: 'The Crow',
          first_air_date: '1994-09-01',
          popularity: 50,
        },
      ],
      details: {
        100: {
          id: 100,
          name: 'The Crow',
          original_name: 'The Crow',
          first_air_date: '1994-09-01',
          number_of_seasons: 0,
          number_of_episodes: 0,
          seasons: [],
        },
      },
    })

    await validateShows(
      [show('the crow', 1994)],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().some(w => w.issue.match(/filename-safe form is/i))).toBe(true)
  })

  it('warn_tmdb_low_confidence includes Alternatives: text when alternate candidates are cached', async () => {
    const client = mockClient({
      searchResults: [
        {
          id: 1,
          name: 'The Big Adventure Show',
          original_name: 'The Big Adventure Show',
          first_air_date: '2020-01-01',
          popularity: 100,
        },
        {
          id: 2,
          name: 'Adventure Time',
          original_name: 'Adventure Time',
          first_air_date: '2010-01-01',
          popularity: 5,
        },
      ],
      details: {
        1: {
          id: 1,
          name: 'The Big Adventure Show',
          original_name: 'The Big Adventure Show',
          first_air_date: '2020-01-01',
          number_of_seasons: 0,
          number_of_episodes: 0,
          seasons: [],
        },
      },
    })
    const detailsCache = memoryCache<TmdbShowDetails>({
      '2': {
        id: 2,
        name: 'Adventure Time',
        original_name: 'Adventure Time',
        first_air_date: '2010-01-01',
        number_of_seasons: 0,
        number_of_episodes: 0,
        seasons: [],
      },
    })

    await validateShows(
      [show('Adventure', 2020)],
      defaultShowsRules,
      client,
      memoryCache(),
      detailsCache,
      memoryCache(),
      warnings
    )

    const lowWarn = warnings.all().find(w => w.issue.match(/below the confidence threshold/i))
    expect(lowWarn?.issue).toMatch(/Alternatives:/)
    expect(lowWarn?.issue).toContain("'Adventure Time'")
  })

  it('silences each toggleable warning when set to false', async () => {
    const rules: ShowsRules = {
      ...defaultShowsRules,
      checks: {
        ...defaultShowsRules.checks,
        warn_tmdb_no_match: false,
        warn_tmdb_episode_count: false,
        warn_tmdb_title_canonical: false,
      },
    }
    const client = mockClient({ searchResults: [] })
    await validateShows(
      [show('Missing', 2020)],
      rules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )
    expect(warnings.all()).toEqual([])
  })
})

describe('validateShows — TMDB episode-name validation', () => {
  let warnings: WarningCollector

  beforeEach(() => {
    warnings = new WarningCollector()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const baseDetails: TmdbShowDetails = {
    id: 100,
    name: 'Show',
    original_name: 'Show',
    first_air_date: '2020-01-01',
    number_of_seasons: 1,
    number_of_episodes: 3,
    seasons: [{ season_number: 1, episode_count: 3, name: 'Season 1' }],
  }

  const baseSearch: TmdbShowSearchResult[] = [
    {
      id: 100,
      name: 'Show',
      original_name: 'Show',
      first_air_date: '2020-01-01',
      popularity: 100,
    },
  ]

  it('fires per-episode mismatches with strict normalization', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Pilot' },
            { episode_number: 2, name: 'The Second Episode' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              { episode_start: 1, episode_end: 1, title: 'Pilot' },
              { episode_start: 2, episode_end: 2, title: 'Wrong Title' },
            ],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    const epMismatches = warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')
    expect(epMismatches).toHaveLength(1)
    expect(epMismatches[0]?.path).toMatch(/S01E02/)
    expect(epMismatches[0]?.issue).toContain("'Wrong Title'")
    expect(epMismatches[0]?.issue).toContain("'The Second Episode'")
  })

  it('treats filename-illegal char differences as matching', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [{ episode_number: 1, name: '3:10 to Yuma' }],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 1,
            versions: [{ category: 'default', quality: null }],
            // filename can't contain `:`, so user has the colon stripped
            episodes: [{ episode_start: 1, episode_end: 1, title: '310 to Yuma' }],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('accepts a title whose trailing period Windows will not store', async () => {
    // `All Good Things...` and `T.R.A.C.K.S.` cannot exist on disk with the
    // trailing period — Windows silently drops it. The strict tier compares
    // against a form the filesystem refuses to create, so the loose tier has
    // to catch these or every such episode is a permanent false positive.
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'All Good Things...' },
            { episode_number: 2, name: 'T.R.A.C.K.S.' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              { episode_start: 1, episode_end: 1, title: 'All Good Things' },
              { episode_start: 2, episode_end: 2, title: 'T.R.A.C.K.S' },
            ],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('accepts a title that only matches once an illegal char AND a trailing period are dropped', async () => {
    // SNL 'Chevy Chase/Sheila E.' and The Pitt '7:00 A.M.' are stored as
    // 'Chevy ChaseSheila E' and '700 A.M'. The loose tier turns the deleted
    // '/' or ':' into a space, so only a strict tier that also strips the
    // trailing period can match them.
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Chevy Chase/Sheila E.' },
            { episode_number: 2, name: '7:00 A.M.' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              { episode_start: 1, episode_end: 1, title: 'Chevy ChaseSheila E' },
              { episode_start: 2, episode_end: 2, title: '700 A.M' },
            ],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('still reports a genuinely different episode title', async () => {
    // The loose tier must not be so permissive that real mismatches vanish.
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': { season_number: 1, episodes: [{ episode_number: 1, name: 'Pilot' }] },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 1,
            versions: [{ category: 'default', quality: null }],
            episodes: [{ episode_start: 1, episode_end: 1, title: 'Something Else Entirely' }],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toHaveLength(1)
  })

  it('skips multi-episode files by default', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Broken Bow, Part I' },
            { episode_number: 2, name: 'Broken Bow, Part II' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              {
                episode_start: 1,
                episode_end: 2,
                title: 'Broken Bow Part 1 And 2',
              },
            ],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('checks multi-episode files when warn_tmdb_episode_name_multi_episode is true', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Broken Bow, Part I' },
            { episode_number: 2, name: 'Broken Bow, Part II' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              {
                episode_start: 1,
                episode_end: 2,
                title: 'Some Combined Title',
              },
            ],
          },
        ]),
      ],
      {
        ...defaultShowsRules,
        checks: {
          ...defaultShowsRules.checks,
          warn_tmdb_episode_name_multi_episode: true,
        },
      },
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    const epMismatches = warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')
    expect(epMismatches).toHaveLength(1)
    expect(epMismatches[0]?.path).toMatch(/S01E01-E02/)
  })

  it('accepts a multi-episode file whose combined title contains every TMDB title in order', async () => {
    // User can't use `/` in filenames (Windows path separator), so they
    // join the two episode titles with whatever they like — here two spaces,
    // as if `/` was simply removed. Should NOT flag as a mismatch.
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Made in China (1)' },
            { episode_number: 2, name: 'Last Call (2)' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              {
                episode_start: 1,
                episode_end: 2,
                title: 'Made in China (1)  Last Call (2)',
              },
            ],
          },
        ]),
      ],
      {
        ...defaultShowsRules,
        checks: {
          ...defaultShowsRules.checks,
          warn_tmdb_episode_name_multi_episode: true,
        },
      },
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('accepts a multi-episode combined title regardless of joiner (& comma ampersand etc.)', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'The One with Two Parts (1)' },
            { episode_number: 2, name: 'The One with Two Parts (2)' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              {
                episode_start: 1,
                episode_end: 2,
                title: 'The One with Two Parts (1) & The One with Two Parts (2)',
              },
            ],
          },
        ]),
      ],
      {
        ...defaultShowsRules,
        checks: {
          ...defaultShowsRules.checks,
          warn_tmdb_episode_name_multi_episode: true,
        },
      },
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('still flags a multi-episode combined title that has the parts in the wrong order', async () => {
    // Order matters — if the user wrote the titles backwards, that's a real
    // anomaly worth surfacing.
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [
            { episode_number: 1, name: 'Alpha' },
            { episode_number: 2, name: 'Bravo' },
          ],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 2,
            versions: [{ category: 'default', quality: null }],
            episodes: [
              {
                episode_start: 1,
                episode_end: 2,
                title: 'Bravo and Alpha', // reversed
              },
            ],
          },
        ]),
      ],
      {
        ...defaultShowsRules,
        checks: {
          ...defaultShowsRules.checks,
          warn_tmdb_episode_name_multi_episode: true,
        },
      },
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toHaveLength(1)
  })

  it('skips episodes whose filename omits the title', async () => {
    const client = mockClient({
      searchResults: baseSearch,
      details: { 100: baseDetails },
      seasons: {
        '100:1': {
          season_number: 1,
          episodes: [{ episode_number: 1, name: 'Pilot' }],
        },
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 1,
            versions: [{ category: 'default', quality: null }],
            episodes: [{ episode_start: 1, episode_end: 1, title: null }],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })

  it('does not call getShowSeason when the toggle is off', async () => {
    const seasonsCall = vi.fn()
    const client = {
      searchShow: vi.fn(async () => baseSearch),
      getShow: vi.fn(async () => baseDetails),
      getShowSeason: seasonsCall,
      get totalRequests() {
        return 0
      },
    } as unknown as TmdbClient

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 1,
            versions: [{ category: 'default', quality: null }],
            episodes: [{ episode_start: 1, episode_end: 1, title: 'Pilot' }],
          },
        ]),
      ],
      {
        ...defaultShowsRules,
        checks: {
          ...defaultShowsRules.checks,
          warn_tmdb_episode_name_mismatch: false,
        },
      },
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      warnings
    )

    expect(seasonsCall).not.toHaveBeenCalled()
  })

  it('reuses the seasons cache instead of hitting the client', async () => {
    const seasonsCall = vi.fn()
    const client = {
      searchShow: vi.fn(async () => baseSearch),
      getShow: vi.fn(async () => baseDetails),
      getShowSeason: seasonsCall,
      get totalRequests() {
        return 0
      },
    } as unknown as TmdbClient

    const seasonsCache = memoryCache<TmdbSeasonDetails>({
      '100:1': {
        season_number: 1,
        episodes: [{ episode_number: 1, name: 'Pilot' }],
      },
    })

    await validateShows(
      [
        show('Show', 2020, [
          {
            season: '1',
            episode_count: 1,
            versions: [{ category: 'default', quality: null }],
            episodes: [{ episode_start: 1, episode_end: 1, title: 'Pilot' }],
          },
        ]),
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      seasonsCache,
      warnings
    )

    expect(seasonsCall).not.toHaveBeenCalled()
    expect(warnings.all().filter(w => w.type === 'warn_tmdb_episode_name_mismatch')).toEqual([])
  })
})
