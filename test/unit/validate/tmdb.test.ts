import { describe, it, expect } from 'vitest'

import { slimSeasonDetails } from '../../../src/validate/tmdb'
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
