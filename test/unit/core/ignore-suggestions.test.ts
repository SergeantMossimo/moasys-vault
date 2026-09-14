import { describe, it, expect } from 'vitest'
import jsYaml from 'js-yaml'

import {
  deriveScope,
  isWarningIgnored,
  parseIgnoreList,
  suggestIgnoreEntry,
  type IgnoreMediaType,
  type WarningScope,
} from '../../../src/core/ignored'
import { WarningCollector } from '../../../src/core/types'

/**
 * Turn a suggestion like `shows: Firefly (2002)` into the YAML a user would
 * paste, load it through the real parser, and return the resulting list.
 */
function pasted(suggestion: string, mediaType: IgnoreMediaType) {
  const [key, ...rest] = suggestion.split(': ')
  const yaml = `${key}:\n  - ${rest.join(': ')}\n`
  return parseIgnoreList(jsYaml.load(yaml), mediaType, 'pasted.yaml')
}

const scope = (path: string, hasCategories = true): WarningScope => deriveScope(path, hasCategories)

describe('suggestIgnoreEntry', () => {
  const cases: Array<{
    mediaType: IgnoreMediaType
    path: string
    expected: string
    sibling: string
  }> = [
    {
      mediaType: 'movies',
      path: 'HD',
      expected: 'folders: HD',
      sibling: 'SD',
    },
    {
      mediaType: 'movies',
      path: 'HD/The Crow (1994)',
      expected: 'movies: The Crow (1994)',
      sibling: 'HD/The Crow 2 (1996)',
    },
    {
      mediaType: 'movies',
      path: 'HD/The Crow (1994)/The Crow (1994).mkv',
      expected: 'files: The Crow (1994)/The Crow (1994).mkv',
      sibling: 'HD/The Crow (1994)/The Crow (1994) {edition-Director’s Cut}.mkv',
    },
    {
      mediaType: 'shows',
      path: 'HD/Firefly (2002)/Season 01',
      expected: 'seasons: Firefly (2002)/Season 01',
      sibling: 'HD/Firefly (2002)/Season 02',
    },
    {
      mediaType: 'shows',
      path: 'HD/Firefly (2002)/Season 01/Firefly (2002) - s01e05 - Safe.mp4',
      expected: 'episodes: Firefly (2002)/S01E05',
      sibling: 'HD/Firefly (2002)/Season 01/Firefly (2002) - s01e06 - Our Mrs. Reynolds.mp4',
    },
    {
      mediaType: 'music',
      path: 'Music/Pink Floyd/The Wall',
      expected: 'albums: Pink Floyd/The Wall',
      sibling: 'Music/Roger Waters/The Wall',
    },
    {
      mediaType: 'music',
      path: 'Music/Pink Floyd/The Wall/101 - In the Flesh.flac',
      expected: 'songs: Pink Floyd/The Wall/101 - In the Flesh.flac',
      sibling: 'Music/Pink Floyd/The Wall/102 - The Thin Ice.flac',
    },
    {
      mediaType: 'audiobooks',
      path: 'Audible/J.R.R. Tolkien/The Hobbit/09 - Chapter 9.mp3',
      expected: 'chapters: J.R.R. Tolkien/The Hobbit/09 - Chapter 9.mp3',
      sibling: 'Audible/J.R.R. Tolkien/The Silmarillion/09 - Chapter 9.mp3',
    },
  ]

  it.each(cases)('$mediaType $path → $expected', ({ mediaType, path, expected, sibling }) => {
    const suggestion = suggestIgnoreEntry(scope(path), mediaType)
    expect(suggestion).toBe(expected)

    const list = pasted(suggestion!, mediaType)
    expect(isWarningIgnored(scope(path), list)).toBe(true)
    expect(isWarningIgnored(scope(sibling), list)).toBe(false)
  })

  it('covers the TMDB pass too: an episode code path is silenced by the same entry', () => {
    const list = pasted(
      suggestIgnoreEntry(
        scope('HD/Firefly (2002)/Season 01/Firefly (2002) - s01e05 - Safe.mp4'),
        'shows'
      )!,
      'shows'
    )
    expect(isWarningIgnored(scope('HD/Firefly (2002)/Season 1/S01E05'), list)).toBe(true)
  })

  it('works for libraries with no categories', () => {
    const s = scope('The Crow (1994)', false)
    expect(suggestIgnoreEntry(s, 'movies')).toBe('movies: The Crow (1994)')
    expect(suggestIgnoreEntry(scope('', false), 'movies')).toBeNull()
  })

  it('caps paths deeper than the deepest level at that level', () => {
    const deep = 'HD/The Crow (1994)/Extras/Behind the Scenes.mkv'
    const suggestion = suggestIgnoreEntry(scope(deep), 'movies')
    expect(suggestion).toBe('files: The Crow (1994)/Extras')
    expect(isWarningIgnored(scope(deep), pasted(suggestion!, 'movies'))).toBe(true)
  })

  it('quotes names YAML would otherwise misread', () => {
    const suggestion = suggestIgnoreEntry(
      scope("SD/'Twas the Night Before Christmas (1974)"),
      'movies'
    )
    expect(suggestion).toBe(`movies: "'Twas the Night Before Christmas (1974)"`)
    const list = pasted(suggestion!, 'movies')
    expect(isWarningIgnored(scope("SD/'Twas the Night Before Christmas (1974)"), list)).toBe(true)
  })

  it('uses an explicit scope for display-label checks that span categories', () => {
    const labelScope: WarningScope = {
      categories: ['HD', 'Other HD'],
      levels: ['Firefly (2002)', 'Season 1'],
    }
    expect(suggestIgnoreEntry(labelScope, 'shows')).toBe('seasons: Firefly (2002)/Season 1')
  })
})

describe('WarningCollector ignore suggestions', () => {
  it('adds an ignore entry to each row when constructed with an ignore list', () => {
    const wc = new WarningCollector({ mediaType: 'shows', entries: [] })
    wc.add('warn_episode_gaps', 'HD\\Firefly (2002)\\Season 01', 'gap')
    expect(wc.groupedByType()['warn_episode_gaps']).toEqual([
      {
        path: 'HD/Firefly (2002)/Season 01',
        issue: 'gap',
        ignore: 'seasons: Firefly (2002)/Season 01',
      },
    ])
  })

  it('leaves rows unchanged when no ignore list was supplied', () => {
    const wc = new WarningCollector()
    wc.add('warn_x', 'HD/Firefly (2002)', 'x')
    expect(wc.groupedByType()['warn_x']).toEqual([{ path: 'HD/Firefly (2002)', issue: 'x' }])
  })

  it('never suggests an entry for a warning that was silenced', () => {
    const list = parseIgnoreList({ shows: ['Firefly (2002)'] }, 'shows', 'test.yaml')
    const wc = new WarningCollector(list)
    wc.add('warn_x', 'HD/Firefly (2002)/Season 01', 'x')
    expect(wc.count()).toBe(0)
    expect(wc.silencedCount()).toBe(1)
  })
})
