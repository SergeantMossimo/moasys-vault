import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  MAX_429_RETRIES,
  MAX_APPENDED,
  MAX_CONSECUTIVE_FAILURES,
  TRANSIENT_RETRIES,
  TmdbAbortError,
  KEPT_CAST,
  TmdbClient,
  slimMovieDetails,
  slimSeasonDetails,
  slimShowDetails,
} from '../../../src/validate/tmdb'
import type {
  TmdbMovieDetails,
  TmdbSeasonDetails,
  TmdbShowDetails,
} from '../../../src/validate/types'

describe('slimSeasonDetails', () => {
  // The shape TMDB actually returns — far more than TmdbSeasonDetails declares.
  const raw = {
    _id: '5256c89f19c2956ff6046d47',
    id: 3572,
    season_number: 1,
    name: 'Season 1',
    air_date: '2005-09-20',
    overview: 'A long overview...',
    poster_path: '/poster.jpg',
    vote_average: 8.1,
    networks: [{ id: 16, name: 'NBC' }],
    episodes: [
      {
        episode_number: 1,
        name: 'Pilot',
        air_date: '2005-09-20',
        id: 223921,
        overview: 'Earl wins the lottery...',
        runtime: 22,
        still_path: '/still.jpg',
        crew: [{ id: 1, name: 'Director', job: 'Director' }],
        guest_stars: [{ id: 2, name: 'Guest', character: 'Someone' }],
      },
      { episode_number: 2, name: 'Quit Smoking' },
    ],
  } as unknown as TmdbSeasonDetails

  it('keeps only the declared season and episode fields', () => {
    expect(slimSeasonDetails(raw)).toEqual({
      id: 3572,
      season_number: 1,
      name: 'Season 1',
      episodes: [
        { episode_number: 1, name: 'Pilot', air_date: '2005-09-20' },
        { episode_number: 2, name: 'Quit Smoking' },
      ],
    })
  })

  it('is idempotent, so re-slimming an already-slim cache entry changes nothing', () => {
    const once = slimSeasonDetails(raw)
    expect(slimSeasonDetails(once)).toEqual(once)
  })

  it('tolerates a season with no episodes array', () => {
    const bare = { season_number: 0 } as unknown as TmdbSeasonDetails
    expect(slimSeasonDetails(bare)).toEqual({ season_number: 0, episodes: [] })
  })
})

describe('slimMovieDetails', () => {
  // /movie/<id>?append_to_response=credits,keywords, cut down.
  const raw = {
    id: 11,
    title: 'Star Wars',
    original_title: 'Star Wars',
    belongs_to_collection: { id: 10, name: 'Star Wars Collection' },
    credits: {
      cast: Array.from({ length: KEPT_CAST + 5 }, (_, i) => ({
        id: i,
        name: `Actor ${i}`,
        character: i === 1 ? '' : `Role ${i}`,
        order: i,
        profile_path: '/p.jpg',
      })),
      crew: [
        { id: 1, name: 'George Lucas', job: 'Director', department: 'Directing' },
        { id: 1, name: 'George Lucas', job: 'Writer', department: 'Writing' },
        { id: 2, name: 'John Williams', job: 'Original Music Composer', department: 'Sound' },
        // Any Writing job is kept, not only a fixed list.
        { id: 3, name: 'Stephen King', job: 'Short Story', department: 'Writing' },
      ],
    },
    keywords: {
      keywords: [
        { id: 1, name: 'space opera' },
        { id: 2, name: 'rebellion' },
      ],
    },
  } as unknown as TmdbMovieDetails

  it('keeps the top-billed cast, the director and writers, and keyword names', () => {
    const slim = slimMovieDetails(raw)
    expect(slim.credits?.cast).toHaveLength(KEPT_CAST)
    expect(slim.credits?.cast[0]).toEqual({ id: 0, name: 'Actor 0', character: 'Role 0' })
    // An empty character is dropped rather than kept as ''.
    expect(slim.credits?.cast[1]).toEqual({ id: 1, name: 'Actor 1' })
    expect(slim.credits?.crew).toEqual([
      { id: 1, name: 'George Lucas', job: 'Director' },
      { id: 1, name: 'George Lucas', job: 'Writer' },
      { id: 3, name: 'Stephen King', job: 'Short Story' },
    ])
    expect(slim.keywords).toEqual(['space opera', 'rebellion'])
  })

  it('keeps every other field as TMDB sent it', () => {
    expect(slimMovieDetails(raw)).toMatchObject({
      id: 11,
      belongs_to_collection: { id: 10, name: 'Star Wars Collection' },
    })
  })

  it('is idempotent', () => {
    const once = slimMovieDetails(raw)
    expect(slimMovieDetails(once)).toEqual(once)
  })

  it('passes a response without credits or keywords through unchanged', () => {
    const bare = { id: 3, title: 'X', original_title: 'X' }
    expect(slimMovieDetails(bare)).toEqual(bare)
  })
})

describe('slimShowDetails', () => {
  // /tv/<id>?append_to_response=aggregate_credits,keywords, cut down.
  const raw = {
    id: 1399,
    name: 'Game of Thrones',
    original_name: 'Game of Thrones',
    number_of_seasons: 8,
    number_of_episodes: 73,
    seasons: [],
    aggregate_credits: {
      cast: [
        {
          id: 22970,
          name: 'Peter Dinklage',
          roles: [{ character: 'Tyrion Lannister', episode_count: 67 }],
          total_episode_count: 67,
        },
      ],
      // One entry per person per department, each with its own jobs list.
      crew: [
        {
          id: 9813,
          name: 'David Benioff',
          department: 'Writing',
          jobs: [
            { job: 'Writer', episode_count: 51 },
            { job: 'Story', episode_count: 20 },
          ],
        },
        {
          id: 9813,
          name: 'David Benioff',
          department: 'Production',
          jobs: [{ job: 'Executive Producer', episode_count: 73 }],
        },
        {
          id: 9813,
          name: 'David Benioff',
          department: 'Directing',
          jobs: [{ job: 'Director', episode_count: 2 }],
        },
        {
          id: 237053,
          name: 'George R. R. Martin',
          department: 'Writing',
          jobs: [{ job: 'Novel', episode_count: 73 }],
        },
      ],
    },
    keywords: { results: [{ id: 818, name: 'based on novel or book' }] },
  } as unknown as TmdbShowDetails

  it('flattens aggregate credits into credits, one crew row per kept job', () => {
    const slim = slimShowDetails(raw)
    expect(slim).not.toHaveProperty('aggregate_credits')
    expect(slim.credits).toEqual({
      cast: [{ id: 22970, name: 'Peter Dinklage', character: 'Tyrion Lannister' }],
      crew: [
        { id: 9813, name: 'David Benioff', job: 'Writer' },
        { id: 9813, name: 'David Benioff', job: 'Story' },
        { id: 9813, name: 'David Benioff', job: 'Director' },
        { id: 237053, name: 'George R. R. Martin', job: 'Novel' },
      ],
    })
  })

  it("reads a show's keywords from `results`", () => {
    expect(slimShowDetails(raw).keywords).toEqual(['based on novel or book'])
  })

  it('is idempotent', () => {
    const once = slimShowDetails(raw)
    expect(slimShowDetails(once)).toEqual(once)
  })
})

describe('TmdbClient request handling', () => {
  const noSleep = async () => {}
  const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries a 429 and returns the eventual response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(200, { id: 1, season_number: 1, episodes: [] }))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    await expect(client.getShowSeason(1, 1)).resolves.toEqual({
      id: 1,
      season_number: 1,
      episodes: [],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it(`gives up after ${MAX_429_RETRIES} consecutive 429s instead of retrying forever`, async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(429))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    await expect(client.getMovie(1)).rejects.toThrow(/still rate-limiting/)
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_429_RETRIES + 1)
  })

  it('reports a timeout without leaking the API key', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))
    const client = new TmdbClient('secret-key-123', fetchImpl as unknown as typeof fetch, noSleep)

    const error = (await client.getMovie(1).catch((e: unknown) => e)) as Error
    expect(error.message).toMatch(/timed out after 30s/)
    expect(error.message).not.toContain('secret-key-123')
  })

  it('passes an abort signal so a hung connection can time out', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { id: 7 }))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    await client.getMovie(7)
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborts the run on a 401 rather than failing title by title', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401))
    const client = new TmdbClient('wrong', fetchImpl as unknown as typeof fetch, noSleep)

    await expect(client.getMovie(1)).rejects.toBeInstanceOf(TmdbAbortError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it(`retries a 5xx or network error ${TRANSIENT_RETRIES} times before giving up`, async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(503))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(json(200, { id: 3 }))
    const sleeps: number[] = []
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, async ms => {
      sleeps.push(ms)
    })

    await expect(client.getMovie(3)).resolves.toEqual({ id: 3 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleeps.filter(ms => ms >= 2000)).toEqual([2000, 4000])
  })

  it(`fetches seasons ${MAX_APPENDED} at a time, appended to the show request`, async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const appended = new URL(url).searchParams.get('append_to_response')!.split(',')
      const body: Record<string, unknown> = { id: 456 }
      for (const key of appended) {
        body[key] = { season_number: Number(key.split('/')[1]), episodes: [], overview: 'x' }
      }
      return json(200, body)
    })
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)
    const wanted = Array.from({ length: 25 }, (_, i) => i + 1)

    const seasons = await client.getShowSeasons(456, wanted)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const sizes = fetchImpl.mock.calls.map(
      c => new URL(c[0] as string).searchParams.get('append_to_response')!.split(',').length
    )
    expect(sizes).toEqual([MAX_APPENDED, 5])
    expect([...seasons.keys()]).toEqual(wanted)
    // Slimmed like a single-season fetch.
    expect(seasons.get(3)).toEqual({ season_number: 3, episodes: [] })
  })

  it('appends credits and keywords to the movie and show details requests', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(200, { id: 1 }))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    await client.getMovie(1)
    await client.getShow(1)

    const appended = fetchImpl.mock.calls.map(c =>
      new URL(c[0] as string).searchParams.get('append_to_response')
    )
    expect(appended).toEqual(['credits,keywords', 'aggregate_credits,keywords'])
  })

  it('does not retry a 404 — that is an answer, not an outage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(404))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    await expect(client.getMovie(1)).rejects.toThrow('404')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it(`aborts once ${MAX_CONSECUTIVE_FAILURES} requests in a row fail`, async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND api.themoviedb.org'))
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const err = await client.getMovie(i).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(TmdbAbortError)
    }
    await expect(client.getMovie(99)).rejects.toThrow(/TMDB unreachable/)
  })

  it('resets the failure streak after a success', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/movie/0')) return json(200, { id: 0 })
      throw new Error('ENOTFOUND')
    })
    const client = new TmdbClient('key', fetchImpl as unknown as typeof fetch, noSleep)

    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await expect(client.getMovie(i)).rejects.not.toBeInstanceOf(TmdbAbortError)
      }
      await client.getMovie(0)
    }
  })
})
