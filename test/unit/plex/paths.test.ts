import { describe, it, expect } from 'vitest'

import { PathMapper, normalizePath, rootRefs, stripPrefix } from '../../../src/plex/paths'
import type { PlexSection } from '../../../src/plex/types'

const roots = rootRefs({
  movies: [
    { root_path: 'M:\\Movies', name: 'Server' },
    { root_path: 'D:\\Movies', name: 'External' },
  ],
  shows: [
    { root_path: 'M:\\Shows', name: 'Server' },
    { root_path: 'D:\\Shows\\Move', name: 'External' },
  ],
  music: [{ root_path: 'M:\\Audio', name: 'Server' }],
  audiobooks: [{ root_path: 'M:\\Audiobooks', name: 'Server' }],
})

function section(title: string, type: string, ...paths: string[]): PlexSection {
  return { key: title, type, title, Location: paths.map((path, id) => ({ id, path })) }
}

describe('normalizePath / stripPrefix', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(normalizePath('M:\\Movies\\HD\\')).toBe('M:/Movies/HD')
    expect(normalizePath('/volume1//Media/')).toBe('/volume1/Media')
  })

  it('strips a prefix case-insensitively and only at a folder boundary', () => {
    expect(stripPrefix('/volume1/Media/Movies/HD/a.mkv', '/volume1/media/movies')).toBe('HD/a.mkv')
    expect(stripPrefix('/volume1/Media/MoviesExtra/a.mkv', '/volume1/Media/Movies')).toBeNull()
    expect(stripPrefix('/volume1/Media/Movies', '/volume1/Media/Movies')).toBe('')
  })
})

describe('PathMapper — automatic', () => {
  it('maps a library folder to the root with the same final folder name', () => {
    const mapper = new PathMapper(roots, [section('Movies', 'movie', '/volume1/Media/Movies')])
    expect(mapper.map('/volume1/Media/Movies/HD/Heat (1995)/Heat (1995).mkv')).toEqual({
      mediaType: 'movies',
      drive: 'Server',
      relative: 'HD/Heat (1995)/Heat (1995).mkv',
    })
  })

  it('maps a library pointed at a sub-folder of a root', () => {
    const mapper = new PathMapper(roots, [section('4K', 'movie', '/volume1/Media/Movies/UHD')])
    expect(mapper.map('/volume1/Media/Movies/UHD/Dune (2021)/Dune (2021).mkv')?.relative).toBe(
      'UHD/Dune (2021)/Dune (2021).mkv'
    )
  })

  it('tells music and audiobooks apart by folder, not library type', () => {
    const mapper = new PathMapper(roots, [
      section('Music', 'artist', '/volume1/Media/Audio'),
      section('Audiobooks', 'artist', '/volume1/Media/Audiobooks'),
    ])
    expect(mapper.sectionMediaType(section('Music', 'artist', '/volume1/Media/Audio'))).toBe(
      'music'
    )
    expect(
      mapper.sectionMediaType(section('Audiobooks', 'artist', '/volume1/Media/Audiobooks'))
    ).toBe('audiobooks')
  })

  it('handles Windows-style server paths', () => {
    const mapper = new PathMapper(roots, [section('TV', 'show', 'E:\\Media\\Shows')])
    expect(mapper.map('E:\\Media\\Shows\\Firefly (2002)\\Season 01\\ep.mkv')?.relative).toBe(
      'Firefly (2002)/Season 01/ep.mkv'
    )
  })

  it('records a location that matches no root', () => {
    const mapper = new PathMapper(roots, [section('Photos', 'photo', '/volume1/Pictures')])
    expect(mapper.unmappedLocations).toEqual([{ library: 'Photos', path: '/volume1/Pictures' }])
    expect(mapper.map('/volume1/Pictures/a.jpg')).toBeNull()
  })

  it('records a location matching several roots and uses the first', () => {
    const mapper = new PathMapper(roots, [section('Movies', 'movie', '/volume1/Movies')])
    expect(mapper.ambiguousLocations).toHaveLength(1)
    expect(mapper.map('/volume1/Movies/HD/a.mkv')?.drive).toBe('Server')
  })
})

describe('PathMapper — path_map', () => {
  it('uses path_map over automatic matching', () => {
    const mapper = new PathMapper(
      roots,
      [section('Movies', 'movie', '/share/Films')],
      [{ plex: '/share/Films', local: 'D:\\Movies' }]
    )
    expect(mapper.map('/share/Films/SD/a.mkv')).toEqual({
      mediaType: 'movies',
      drive: 'External',
      relative: 'SD/a.mkv',
    })
    expect(mapper.unmappedLocations).toEqual([])
  })

  it('picks the most specific root for a translated path', () => {
    const mapper = new PathMapper(roots, [], [{ plex: '/share', local: 'D:\\Shows' }])
    expect(mapper.map('/share/Move/Firefly (2002)/Season 01/ep.mkv')).toEqual({
      mediaType: 'shows',
      drive: 'External',
      relative: 'Firefly (2002)/Season 01/ep.mkv',
    })
  })

  it('prefers the longest path_map prefix', () => {
    const mapper = new PathMapper(
      roots,
      [],
      [
        { plex: '/volume1', local: 'M:\\' },
        { plex: '/volume1/usb', local: 'D:\\' },
      ]
    )
    expect(mapper.map('/volume1/usb/Movies/HD/a.mkv')?.drive).toBe('External')
    expect(mapper.map('/volume1/Movies/HD/a.mkv')?.drive).toBe('Server')
  })
})
