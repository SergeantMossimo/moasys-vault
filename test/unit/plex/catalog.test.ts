import { describe, it, expect } from 'vitest'

import {
  agentMatches,
  assignSlugs,
  isUnmatched,
  itemTypesFor,
  slugify,
  toCatalogItem,
  toCollection,
} from '../../../src/plex/catalog'
import { PathMapper, rootRefs } from '../../../src/plex/paths'
import type { PlexSection } from '../../../src/plex/types'

const section = (key: string, title: string, type = 'movie'): PlexSection => ({ key, title, type })

describe('slugify / assignSlugs', () => {
  it('produces folder-safe names', () => {
    expect(slugify('TV Shows')).toBe('tv-shows')
    expect(slugify("Kids' Movies (4K)")).toBe('kids-movies-4k')
    expect(slugify('Películas')).toBe('peliculas')
    expect(slugify('★★★')).toBe('library')
  })

  it('disambiguates colliding slugs with the section key', () => {
    const slugs = assignSlugs([section('1', 'Movies'), section('7', 'movies!'), section('3', 'TV')])
    expect(slugs.get('1')).toBe('movies-1')
    expect(slugs.get('7')).toBe('movies-7')
    expect(slugs.get('3')).toBe('tv')
  })
})

describe('itemTypesFor', () => {
  it('pulls files-owning types per library type and skips photos', () => {
    expect(itemTypesFor('movie')).toEqual(['movie'])
    expect(itemTypesFor('show')).toEqual(['show', 'episode'])
    expect(itemTypesFor('artist')).toEqual(['artist', 'album', 'track'])
    expect(itemTypesFor('photo')).toEqual([])
  })
})

describe('toCatalogItem', () => {
  const mapper = new PathMapper(
    rootRefs({
      movies: [{ root_path: 'M:\\Movies', name: 'Server' }],
      shows: [{ root_path: 'M:\\Shows', name: 'Server' }],
      music: [{ root_path: 'M:\\Audio', name: 'Server' }],
      audiobooks: [{ root_path: 'M:\\Audiobooks', name: 'Server' }],
    }),
    [{ key: '1', type: 'movie', title: 'Movies', Location: [{ id: 1, path: '/data/Movies' }] }]
  )

  it('maps files, external ids, deletion, and the duplicate flag', () => {
    const item = toCatalogItem(
      {
        ratingKey: '42',
        type: 'movie',
        title: 'Heat',
        year: 1995,
        guid: 'plex://movie/abc',
        Guid: [{ id: 'imdb://tt0113277' }],
        Media: [
          { id: 1, Part: [{ id: 1, file: '/data/Movies/HD/Heat (1995)/Heat (1995).mkv' }] },
          { id: 2, Part: [{ id: 2, file: '/elsewhere/Heat.mkv', deletedAt: 1700000000 }] },
        ],
      },
      'movie',
      mapper,
      new Set(['42'])
    )
    expect(item.external_ids).toEqual(['imdb://tt0113277'])
    expect(item.duplicate).toBe(true)
    expect(item.edition_title).toBeNull()
    expect(item.files).toEqual([
      {
        plex_path: '/data/Movies/HD/Heat (1995)/Heat (1995).mkv',
        drive: 'Server',
        library_path: 'HD/Heat (1995)/Heat (1995).mkv',
        deleted: false,
      },
      { plex_path: '/elsewhere/Heat.mkv', drive: null, library_path: null, deleted: true },
    ])
  })

  // Plex reports editionTitle on shows as well as movies, off the show folder's
  // {edition-…} tag. One mapping serves both — nothing here branches on type.
  it('carries the edition name through for a show', () => {
    const item = toCatalogItem(
      {
        ratingKey: '7',
        type: 'show',
        title: 'Spider-Noir',
        year: 2026,
        editionTitle: 'True Hue Color',
      },
      'show',
      mapper,
      new Set()
    )
    expect(item.edition_title).toBe('True Hue Color')
    expect(item.files).toEqual([])
  })
})

describe('toCollection', () => {
  it('shapes a collection and its children', () => {
    expect(
      toCollection(
        { ratingKey: '9', type: 'collection', title: 'Heist', subtype: 'movie', smart: '1' },
        [{ ratingKey: '42', type: 'movie', title: 'Heat', year: 1995 }]
      )
    ).toEqual({
      rating_key: '9',
      title: 'Heist',
      subtype: 'movie',
      smart: true,
      item_count: 1,
      items: [{ rating_key: '42', type: 'movie', title: 'Heat', year: 1995 }],
    })
  })
})

describe('agentMatches / isUnmatched', () => {
  it('treats Personal Media agents as never matching', () => {
    expect(agentMatches('tv.plex.agents.movie')).toBe(true)
    expect(agentMatches('tv.plex.agents.none')).toBe(false)
    expect(agentMatches('com.plexapp.agents.none')).toBe(false)
  })

  it('recognizes unmatched guids', () => {
    expect(isUnmatched({ guid: 'local://123' })).toBe(true)
    expect(isUnmatched({ guid: 'com.plexapp.agents.none://abc' })).toBe(true)
    expect(isUnmatched({ guid: null })).toBe(true)
    expect(isUnmatched({ guid: 'plex://movie/5d77' })).toBe(false)
  })
})
