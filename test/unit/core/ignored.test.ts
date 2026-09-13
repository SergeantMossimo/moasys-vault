import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  deriveScope,
  IgnoreListError,
  isWarningIgnored,
  loadIgnoreList,
  parseIgnoreList,
} from '../../../src/core/ignored'
import type { IgnoreList, IgnoreMediaType, WarningScope } from '../../../src/core/ignored'

/** Build a list from a YAML-shaped object, the way a real file parses. */
function list(mediaType: IgnoreMediaType, raw: Record<string, string[]>): IgnoreList {
  return parseIgnoreList(raw, mediaType, 'test.yaml')
}

/** A categorized warning scope: `scope('HD', 'Show (2020)', 'Season 01')`. */
function scope(category: string, ...levels: string[]): WarningScope {
  return { categories: category === '' ? [] : [category], levels }
}

describe('deriveScope', () => {
  it('reads the first segment as the category when the library has them', () => {
    expect(deriveScope('HD/Show (2020)/Season 01/ep.mp4', true)).toEqual({
      categories: ['HD'],
      levels: ['Show (2020)', 'Season 01', 'ep.mp4'],
    })
  })

  it('keeps every segment as a level when the library has no categories', () => {
    expect(deriveScope('Show (2020)/Season 01/ep.mp4', false)).toEqual({
      categories: [],
      levels: ['Show (2020)', 'Season 01', 'ep.mp4'],
    })
  })

  it('reads a lone segment as the category, not as an item', () => {
    // Root-level warn_loose_files emits just the category folder name.
    expect(deriveScope('Other HD', true)).toEqual({ categories: ['Other HD'], levels: [] })
  })

  it('handles the empty path a category-less library emits at its root', () => {
    expect(deriveScope('', true)).toEqual({ categories: [], levels: [] })
  })

  it('drops empty segments from doubled or trailing slashes', () => {
    expect(deriveScope('HD/Show (2020)/', true)).toEqual({
      categories: ['HD'],
      levels: ['Show (2020)'],
    })
  })
})

describe('parseIgnoreList', () => {
  it('accepts each media type’s own keys', () => {
    expect(list('movies', { folders: ['Other HD'], movies: ['The Crow (1994)'] }).entries).toEqual([
      { level: 0, names: [['other hd']], key: 'folders' },
      { level: 1, names: [['the crow (1994)']], key: 'movies' },
    ])
    expect(list('music', { artists: ['Pink Floyd'] }).entries).toHaveLength(1)
    expect(list('audiobooks', { authors: ['Charles Dickens'] }).entries).toHaveLength(1)
  })

  it('rejects a key belonging to another media type', () => {
    // Silently accepting it would produce a file that silences nothing.
    expect(() => list('movies', { episodes: ['Show (2000)/S01E01'] })).toThrow(
      /folders, movies, files/
    )
  })

  it('rejects a key whose value is a bare string rather than a list', () => {
    expect(() => list('movies', { movies: 'The Crow (1994)' } as never)).toThrow(IgnoreListError)
  })

  it('rejects an empty-string entry', () => {
    expect(() => list('movies', { movies: [''] })).toThrow(IgnoreListError)
  })

  it('returns an empty list for a comments-only file (YAML null)', () => {
    expect(parseIgnoreList(null, 'shows', 'test.yaml').entries).toEqual([])
  })

  describe('qualifier requirements', () => {
    it.each([
      ['movies', 'files', '300 (2007).mp4'],
      ['shows', 'seasons', 'Season 01'],
      ['shows', 'episodes', 'ep.mp4'],
      ['music', 'songs', '04 - My World View.flac'],
      ['audiobooks', 'chapters', '09 - Chapter 9.mp3'],
    ])('rejects a bare %s `%s` entry', (mediaType, key, value) => {
      expect(() => list(mediaType as IgnoreMediaType, { [key]: [value] })).toThrow(
        /need a parent qualifier/
      )
    })

    it('accepts albums and books either bare or parent-qualified', () => {
      expect(list('music', { albums: ['The Wall', 'Pink Floyd/The Wall'] }).entries).toHaveLength(2)
      expect(
        list('audiobooks', { books: ['The Hobbit', 'Tolkien/The Hobbit'] }).entries
      ).toHaveLength(2)
    })

    it('rejects an entry with more names than its level can take', () => {
      expect(() => list('shows', { seasons: ['A/B/C/D'] })).toThrow(/at most 2 names/)
    })
  })

  describe('old-format detection', () => {
    it('rejects a top-level list with a migration message', () => {
      expect(() => parseIgnoreList(['HD/Show (2020)'], 'shows', 'test.yaml')).toThrow(
        /old flat-list format/
      )
    })

    it('rejects a list of {path, types} objects with the same message', () => {
      // Must beat Zod's "Expected object, received array", which says nothing
      // about the format change that actually broke the file.
      expect(() =>
        parseIgnoreList([{ path: 'HD/Show', types: ['warn_episode_gaps'] }], 'shows', 'test.yaml')
      ).toThrow(/old flat-list format/)
    })
  })

  it('collapses case-insensitive duplicates', () => {
    expect(list('shows', { shows: ['Firefly (2002)', 'FIREFLY (2002)'] }).entries).toHaveLength(1)
  })

  it('normalizes backslash separators so one file works on every platform', () => {
    expect(list('shows', { seasons: ['Show (2000)\\Season 01'] }).entries[0]!.names).toEqual([
      ['show (2000)'],
      ['season 01'],
    ])
  })
})

describe('isWarningIgnored', () => {
  it('returns false for an empty list', () => {
    expect(isWarningIgnored(scope('HD', 'Show (2020)'), list('shows', {}))).toBe(false)
  })

  it('silences a show wherever it lives, in any category', () => {
    // The headline property: names are matched at their level, not by path,
    // so one entry covers every category the show appears in.
    const l = list('shows', { shows: ['Firefly (2002)'] })
    expect(isWarningIgnored(scope('HD', 'Firefly (2002)'), l)).toBe(true)
    expect(isWarningIgnored(scope('Other SD', 'Firefly (2002)', 'Season 03', 'ep.mp4'), l)).toBe(
      true
    )
    // And the label-emitting duplicate checks, which carry no category at all.
    expect(
      isWarningIgnored({ categories: ['HD', 'Other HD'], levels: ['Firefly (2002)'] }, l)
    ).toBe(true)
  })

  it('matches exactly, not by prefix', () => {
    // Regression guard: the old prefix matcher needed a special case to keep
    // `Show` from swallowing `Show 2 (2020)`. Exact matching has no such edge.
    const l = list('shows', { shows: ['Firefly (2002)'] })
    expect(isWarningIgnored(scope('HD', 'Firefly Serenity (2005)'), l)).toBe(false)
  })

  it('never lets an entry reach a warning shallower than itself', () => {
    const l = list('shows', { seasons: ['Firefly (2002)/Season 01'] })
    expect(isWarningIgnored(scope('HD', 'Firefly (2002)'), l)).toBe(false)
    expect(isWarningIgnored(scope('HD', 'Firefly (2002)', 'Season 01'), l)).toBe(true)
  })

  it('is case-insensitive at every level', () => {
    const l = list('shows', { seasons: ['FIREFLY (2002)/season 1'] })
    expect(isWarningIgnored(scope('hd', 'Firefly (2002)', 'Season 01'), l)).toBe(true)
  })

  describe('folders', () => {
    const l = list('shows', { folders: ['Other HD'] })

    it('silences a category-root warning, which has no levels at all', () => {
      expect(isWarningIgnored(scope('Other HD'), l)).toBe(true)
    })

    it('silences everything beneath that category', () => {
      expect(isWarningIgnored(scope('Other HD', 'Show (2020)', 'Season 01'), l)).toBe(true)
    })

    it('leaves other categories alone', () => {
      expect(isWarningIgnored(scope('HD', 'Show (2020)'), l)).toBe(false)
    })

    it('reaches a duplicate check that spans categories', () => {
      // warn_duplicate_quality passes every category the item lives in.
      expect(isWarningIgnored({ categories: ['HD', 'Other HD'], levels: ['Show (2020)'] }, l)).toBe(
        true
      )
    })
  })

  describe('qualified entries', () => {
    it('lets a qualifier match any level above, not just the one directly above', () => {
      // `episodes` is level 3, so a contiguous reading would bind the show
      // name to the season level and match nothing.
      const l = list('shows', { episodes: ['My Name Is Earl (2005)/S03E01'] })
      expect(
        isWarningIgnored(
          scope(
            'HD',
            'My Name Is Earl (2005)',
            'Season 03',
            'My Name Is Earl (2005) - S03E01 - T.mp4'
          ),
          l
        )
      ).toBe(true)
    })

    it('enforces the qualifier order', () => {
      const l = list('shows', { episodes: ['Season 03/My Name Is Earl (2005)'] })
      expect(
        isWarningIgnored(scope('HD', 'My Name Is Earl (2005)', 'Season 03', 'ep.mp4'), l)
      ).toBe(false)
    })

    it('matches a fully contiguous three-name entry', () => {
      const l = list('shows', { episodes: ['Lost (2004)/Season 02/Lost (2004) - s02e21 -.mp4'] })
      expect(
        isWarningIgnored(scope('SD', 'Lost (2004)', 'Season 02', 'Lost (2004) - s02e21 -.mp4'), l)
      ).toBe(true)
    })

    it('requires the qualifier to actually be present', () => {
      const l = list('music', { albums: ['Pink Floyd/The Wall'] })
      expect(isWarningIgnored(scope('Music', 'Pink Floyd', 'The Wall'), l)).toBe(true)
      expect(isWarningIgnored(scope('Music', 'Some Cover Band', 'The Wall'), l)).toBe(false)
    })

    it('lets a song entry skip the album level', () => {
      const l = list('music', { songs: ['Pink Floyd/01 - In the Flesh.flac'] })
      expect(
        isWarningIgnored(scope('Music', 'Pink Floyd', 'The Wall', '01 - In the Flesh.flac'), l)
      ).toBe(true)
    })
  })

  describe('shows season normalization', () => {
    it('folds `Season 3` onto the on-disk `Season 03`', () => {
      // The scan pass emits the folder name, the TMDB pass the parsed number.
      const l = list('shows', { seasons: ['Comedy Central Presents (1998)/Season 3'] })
      expect(isWarningIgnored(scope('SD', 'Comedy Central Presents (1998)', 'Season 03'), l)).toBe(
        true
      )
      expect(isWarningIgnored(scope('SD', 'Comedy Central Presents (1998)', 'Season 3'), l)).toBe(
        true
      )
    })

    it('works when the entry is written padded and the warning is not', () => {
      const l = list('shows', { seasons: ['Show (2000)/Season 03'] })
      expect(isWarningIgnored(scope('HD', 'Show (2000)', 'Season 3'), l)).toBe(true)
    })

    it('leaves named seasons alone', () => {
      const l = list('shows', { seasons: ['Band of Brothers (2001)/Specials'] })
      expect(isWarningIgnored(scope('HD', 'Band of Brothers (2001)', 'Specials'), l)).toBe(true)
      expect(isWarningIgnored(scope('HD', 'Band of Brothers (2001)', 'Season 01'), l)).toBe(false)
    })

    it('does not apply season folding to music or audiobooks', () => {
      const l = list('music', { albums: ['Artist/Season 3'] })
      expect(isWarningIgnored(scope('Music', 'Artist', 'Season 03'), l)).toBe(false)
    })
  })

  describe('shows episode-code aliasing', () => {
    it('silences both the episode file and the bare code from one entry', () => {
      const l = list('shows', { episodes: ['My Name Is Earl (2005)/S03E01'] })
      // Scan pass: the real filename.
      expect(
        isWarningIgnored(
          scope(
            'HD',
            'My Name Is Earl (2005)',
            'Season 03',
            'My Name Is Earl (2005) - S03E01 - Bad Earl.mp4'
          ),
          l
        )
      ).toBe(true)
      // TMDB validate pass: the episode code.
      expect(
        isWarningIgnored(scope('HD', 'My Name Is Earl (2005)', 'Season 03', 'S03E01'), l)
      ).toBe(true)
    })

    it('works the other way round — a filename entry reaches the code warning', () => {
      const l = list('shows', {
        episodes: ['Lost (2004)/Lost (2004) - s02e21 - Hearts and Minds.mp4'],
      })
      expect(isWarningIgnored(scope('SD', 'Lost (2004)', 'Season 02', 'S02E21'), l)).toBe(true)
    })

    it('folds the bare multi-episode suffix onto the explicit one', () => {
      const l = list('shows', { episodes: ['Show (2000)/S01E01-02'] })
      expect(isWarningIgnored(scope('HD', 'Show (2000)', 'Season 01', 'S01E01-E02'), l)).toBe(true)
    })

    it('does not alias a different episode', () => {
      const l = list('shows', { episodes: ['My Name Is Earl (2005)/S03E01'] })
      expect(
        isWarningIgnored(scope('HD', 'My Name Is Earl (2005)', 'Season 03', 'S03E02'), l)
      ).toBe(false)
    })

    it('matches a codeless filename literally', () => {
      const l = list('shows', { episodes: ['Show (2000)/random extra.mp4'] })
      expect(isWarningIgnored(scope('HD', 'Show (2000)', 'Season 01', 'random extra.mp4'), l)).toBe(
        true
      )
    })
  })
})

describe('loadIgnoreList', () => {
  let tmpDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-ignored-'))
    fs.mkdirSync(path.join(tmpDir, 'ignored', 'server'), { recursive: true })
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  /** Write `ignored/<drive>/<name>`, creating the drive folder if needed. */
  function writeYaml(name: string, contents: string, drive = 'server'): void {
    const dir = path.join(tmpDir, 'ignored', drive)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), contents, 'utf-8')
  }

  it('returns an empty list when the file does not exist', () => {
    expect(loadIgnoreList(tmpDir, 'server', 'shows').entries).toEqual([])
  })

  it('returns an empty list when the drive folder does not exist at all', () => {
    expect(loadIgnoreList(tmpDir, 'external', 'shows').entries).toEqual([])
  })

  it('loads level-keyed entries', () => {
    writeYaml('shows.yaml', 'shows:\n  - Firefly (2002)\nfolders:\n  - Other HD\n')
    const loaded = loadIgnoreList(tmpDir, 'server', 'shows')
    expect(loaded.mediaType).toBe('shows')
    expect(loaded.entries).toEqual([
      { level: 0, names: [['other hd']], key: 'folders' },
      { level: 1, names: [['firefly (2002)']], key: 'shows' },
    ])
  })

  it('returns an empty list for a comments-only YAML', () => {
    writeYaml('shows.yaml', '# just a comment\n# nothing else\n')
    expect(loadIgnoreList(tmpDir, 'server', 'shows').entries).toEqual([])
  })

  it('exits when the YAML is malformed', () => {
    writeYaml('shows.yaml', 'shows: [unterminated')
    expect(() => loadIgnoreList(tmpDir, 'server', 'shows')).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Error parsing/))
  })

  it('exits with a migration message on an old flat-list file', () => {
    writeYaml('shows.yaml', '- HD/Firefly (2002)\n- path: HD/Show\n  types: [warn_episode_gaps]\n')
    expect(() => loadIgnoreList(tmpDir, 'server', 'shows')).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/old flat-list format/))
  })

  it('exits when a key belongs to another media type', () => {
    writeYaml('movies.yaml', 'episodes:\n  - Show (2000)/S01E01\n')
    expect(() => loadIgnoreList(tmpDir, 'server', 'movies')).toThrow('process.exit called')
  })

  it('exits when a deepest-level entry has no parent qualifier', () => {
    writeYaml('audiobooks.yaml', 'chapters:\n  - 09 - Chapter 9.mp3\n')
    expect(() => loadIgnoreList(tmpDir, 'server', 'audiobooks')).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/need a parent qualifier/))
  })

  it('loads per-type — each mediaType has its own file', () => {
    writeYaml('movies.yaml', 'movies:\n  - Movie A (2001)\n')
    writeYaml('shows.yaml', 'shows:\n  - Show B (2002)\n')
    expect(loadIgnoreList(tmpDir, 'server', 'movies').entries).toHaveLength(1)
    expect(loadIgnoreList(tmpDir, 'server', 'shows').entries).toHaveLength(1)
    expect(loadIgnoreList(tmpDir, 'server', 'music').entries).toEqual([])
  })

  it('loads per-drive — the same type on another drive is a separate file', () => {
    writeYaml('movies.yaml', 'movies:\n  - Only On Server (2001)\n', 'server')
    writeYaml('movies.yaml', 'movies:\n  - Only On External (2002)\n', 'external')
    expect(loadIgnoreList(tmpDir, 'server', 'movies').entries[0]!.names).toEqual([
      ['only on server (2001)'],
    ])
    expect(loadIgnoreList(tmpDir, 'external', 'movies').entries[0]!.names).toEqual([
      ['only on external (2002)'],
    ])
  })

  it('does not fall back to a top-level ignored/<type>.yaml', () => {
    // Pre-multi-drive layout. It must not leak into a drive-scoped load,
    // otherwise a stale file would silently silence warnings on every drive.
    fs.writeFileSync(
      path.join(tmpDir, 'ignored', 'shows.yaml'),
      'shows:\n  - Legacy (2001)\n',
      'utf-8'
    )
    expect(loadIgnoreList(tmpDir, 'server', 'shows').entries).toEqual([])
  })

  it('ignores the .yaml.example reference file', () => {
    writeYaml('shows.yaml.example', 'shows:\n  - Show From Example (2001)\n')
    expect(loadIgnoreList(tmpDir, 'server', 'shows').entries).toEqual([])
  })
})
