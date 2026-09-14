import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { MAX_429_RETRIES, TmdbClient, slimSeasonDetails } from '../../../src/validate/tmdb'
import type { TmdbSeasonDetails } from '../../../src/validate/types'

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
})
