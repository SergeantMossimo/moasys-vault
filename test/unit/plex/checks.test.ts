import { describe, it, expect } from 'vitest'

import { checkPlex, compareTitles } from '../../../src/plex/checks'
import { defaultPlexRules } from '../../../src/core/rules/plex'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import type {
  MediaType,
  PlexCatalogItem,
  PlexCatalogOutput,
  PlexLibrarySummary,
} from '../../../src/plex/types'

const MOVIE_FOLDER = /^(?<title>.+)\s\((?<year>\d{4})\)$/

function library(overrides: Partial<PlexLibrarySummary> = {}): PlexLibrarySummary {
  return {
    key: '1',
    title: 'Movies',
    plex_type: 'movie',
    slug: 'movies',
    agent: 'tv.plex.agents.movie',
    locations: ['/data/Movies'],
    mapped_locations: [{ plex_path: '/data/Movies', drive: 'Server', library_path: '' }],
    media_type: 'movies',
    item_count: 0,
    collection_count: 0,
    ...overrides,
  }
}

function item(
  overrides: Partial<PlexCatalogItem> & { paths?: string[]; deleted?: boolean }
): PlexCatalogItem {
  const { paths = [], deleted = false, ...rest } = overrides
  return {
    rating_key: 'k',
    type: 'movie',
    title: 'Heat',
    original_title: null,
    year: 1995,
    guid: 'plex://movie/abc',
    external_ids: [],
    grandparent_rating_key: null,
    parent_rating_key: null,
    grandparent_title: null,
    parent_title: null,
    index: null,
    parent_index: null,
    duplicate: false,
    files: paths.map(p => ({
      plex_path: `/data/Movies/${p}`,
      drive: 'Server',
      library_path: p,
      deleted,
    })),
    ...rest,
  }
}

function run(opts: {
  items: PlexCatalogItem[]
  diskFiles?: string[]
  existing?: string[]
  mediaType?: MediaType
  folderPattern?: RegExp | null
  lib?: Partial<PlexLibrarySummary>
  ignored?: Record<string, string[]>
  checks?: Partial<typeof defaultPlexRules.checks>
}) {
  const catalog: PlexCatalogOutput = {
    generated: '',
    library: library(opts.lib),
    items: opts.items,
  }
  const warnings = new WarningCollector(
    parseIgnoreList(opts.ignored ?? {}, opts.mediaType ?? 'movies', 'test.yaml')
  )
  const existing = new Set(opts.existing ?? [])
  checkPlex({
    mediaType: opts.mediaType ?? 'movies',
    drive: 'server',
    catalogs: [catalog],
    diskFiles: opts.diskFiles ?? [],
    exists: p => existing.has(p),
    folderPattern: opts.folderPattern === undefined ? MOVIE_FOLDER : opts.folderPattern,
    rules: { checks: { ...defaultPlexRules.checks, ...opts.checks } },
    warnings,
  })
  return warnings.all()
}

const HEAT = 'HD/Heat (1995)/Heat (1995).mkv'

describe('compareTitles', () => {
  it('matches across illegal characters and colon/dash', () => {
    expect(compareTitles('Ghostbusters: Afterlife', null, 'Ghostbusters - Afterlife')).toBe('match')
    expect(compareTitles('Face/Off', null, 'FaceOff')).toBe('match')
  })

  it('accepts the original title for a localized Plex title', () => {
    expect(compareTitles('The Intouchables', 'Intouchables', 'Intouchables')).toBe('match')
  })

  it('reports capitalization-only and real differences', () => {
    expect(compareTitles('Alice in Wonderland', null, 'Alice In Wonderland')).toBe('case')
    expect(compareTitles('Heat', null, 'Collateral')).toBe('mismatch')
  })
})

describe('checkPlex — disk vs Plex', () => {
  it('is silent when Plex and the scan agree', () => {
    expect(run({ items: [item({ paths: [HEAT] })], diskFiles: [HEAT] })).toEqual([])
  })

  it('flags files on disk that Plex never picked up, grouped by folder', () => {
    const warnings = run({
      items: [item({ paths: [HEAT] })],
      diskFiles: [HEAT, 'HD/Collateral (2004)/Collateral (2004).mkv'],
    })
    expect(warnings.map(w => [w.type, w.path])).toEqual([
      ['warn_plex_missing_item', 'HD/Collateral (2004)'],
    ])
    expect(warnings[0]!.issue).toMatch(/None of the 1 file/)
  })

  it('matches Plex and disk paths case-insensitively', () => {
    const warnings = run({ items: [item({ paths: [HEAT.toLowerCase()] })], diskFiles: [HEAT] })
    // The lowercased folder does fire the capitalization check — but nothing is missing or orphaned.
    expect(warnings.map(w => w.type)).toEqual(['warn_plex_title_case'])
  })

  it('flags a Plex file that is gone from disk as an orphan', () => {
    const warnings = run({ items: [item({ paths: [HEAT] })], diskFiles: [] })
    expect(warnings.map(w => [w.type, w.path])).toEqual([
      ['warn_plex_orphan_item', 'HD/Heat (1995)'],
    ])
  })

  it('does not flag a Plex file the scan skipped but that exists on disk', () => {
    const avi = 'HD/Heat (1995)/Heat (1995).avi'
    expect(run({ items: [item({ paths: [avi] })], existing: [avi] })).toEqual([])
  })

  it('reports trashed files as unavailable, not orphans', () => {
    const warnings = run({ items: [item({ paths: [HEAT], deleted: true })] })
    expect(warnings.map(w => w.type)).toEqual(['warn_plex_unavailable'])
    expect(warnings[0]!.issue).toMatch(/Empty Trash/)
  })

  it('ignores files mapped to another drive', () => {
    const other = item({ paths: [HEAT] })
    other.files[0]!.drive = 'External'
    expect(run({ items: [other] })).toEqual([])
  })
})

describe('checkPlex — items', () => {
  it('flags unmatched movies in a matching library', () => {
    const warnings = run({ items: [item({ paths: [HEAT], guid: 'local://1' })], diskFiles: [HEAT] })
    expect(warnings.map(w => [w.type, w.path])).toEqual([['warn_plex_unmatched', 'HD/Heat (1995)']])
  })

  it('does not flag unmatched items in a Personal Media library', () => {
    expect(
      run({
        items: [item({ paths: [HEAT], guid: 'local://1' })],
        diskFiles: [HEAT],
        lib: { agent: 'tv.plex.agents.none' },
      })
    ).toEqual([])
  })

  it('flags a probable wrong match by title', () => {
    const warnings = run({
      items: [item({ paths: [HEAT], title: 'Collateral', year: 2004 })],
      diskFiles: [HEAT],
    })
    expect(warnings.map(w => w.type)).toEqual(['warn_plex_title_mismatch'])
    expect(warnings[0]!.issue).toContain("'Collateral' (2004)")
  })

  it('flags a year more than one off, but tolerates one', () => {
    expect(run({ items: [item({ paths: [HEAT], year: 1996 })], diskFiles: [HEAT] })).toEqual([])
    expect(
      run({ items: [item({ paths: [HEAT], year: 1999 })], diskFiles: [HEAT] }).map(w => w.type)
    ).toEqual(['warn_plex_title_mismatch'])
  })

  it('reports capitalization-only title differences separately', () => {
    expect(
      run({ items: [item({ paths: [HEAT], title: 'HEAT' })], diskFiles: [HEAT] }).map(w => w.type)
    ).toEqual(['warn_plex_title_case'])
  })

  it('finds a show folder through its episodes', () => {
    const ep = 'Firefly (2002)/Season 01/Firefly (2002) - S01E01.mkv'
    const warnings = run({
      mediaType: 'shows',
      lib: { media_type: 'shows', agent: 'tv.plex.agents.series' },
      items: [
        item({ rating_key: 's1', type: 'show', title: 'Serenity', year: 2002 }),
        item({
          rating_key: 'e1',
          type: 'episode',
          title: 'Serenity',
          grandparent_rating_key: 's1',
          paths: [ep],
        }),
      ],
      diskFiles: [ep],
    })
    expect(warnings.map(w => [w.type, w.path])).toEqual([
      ['warn_plex_title_mismatch', 'Firefly (2002)'],
    ])
  })

  it('flags Plex duplicates with every file location', () => {
    const uhd = 'UHD/Heat (1995)/Heat (1995).mkv'
    const warnings = run({
      items: [item({ paths: [HEAT, uhd], duplicate: true })],
      diskFiles: [HEAT, uhd],
    })
    expect(warnings.map(w => w.type)).toEqual(['warn_plex_duplicate'])
    expect(warnings[0]!.issue).toContain(`Server:${uhd}`)
  })

  it('checks each folder once when several editions share it', () => {
    const warnings = run({
      items: [
        item({ rating_key: 'a', title: 'Collateral', year: 2004, paths: [HEAT] }),
        item({
          rating_key: 'b',
          title: 'Collateral',
          year: 2004,
          paths: ['HD/Heat (1995)/Heat (1995) {edition-Extended}.mkv'],
        }),
      ],
      diskFiles: [HEAT],
    })
    expect(warnings.filter(w => w.type === 'warn_plex_title_mismatch')).toHaveLength(1)
  })

  it('accepts canonical titles that wrap the folder title in the same year', () => {
    const jedi = 'HD/Return of the Jedi (1983)/Return of the Jedi (1983).mkv'
    expect(
      run({
        items: [
          item({ title: 'Star Wars: Episode VI - Return of the Jedi', year: 1983, paths: [jedi] }),
        ],
        diskFiles: [jedi],
      })
    ).toEqual([])
  })

  it('still flags an overlapping title when Plex has no year', () => {
    const mud = 'Other HD/Mud (2013)/Mud (2013).mkv'
    expect(
      run({
        items: [item({ title: 'Mud Lotus', year: null, paths: [mud] })],
        diskFiles: [mud],
      }).map(w => w.type)
    ).toEqual(['warn_plex_title_mismatch'])
  })

  it('ignores Plex disambiguators and leading articles', () => {
    const upside = 'HD/The Upside (2019)/The Upside (2019).mkv'
    expect(
      run({ items: [item({ title: 'Upside', year: null, paths: [upside] })], diskFiles: [upside] })
    ).toEqual([])
    const office = 'The Office (2005)/Season 01/The Office (2005) - S01E01.mkv'
    expect(
      run({
        mediaType: 'shows',
        lib: { media_type: 'shows', agent: 'tv.plex.agents.series' },
        items: [
          item({ rating_key: 's', type: 'show', title: 'The Office (US)', year: 2005 }),
          item({ rating_key: 'e', type: 'episode', grandparent_rating_key: 's', paths: [office] }),
        ],
        diskFiles: [office],
      })
    ).toEqual([])
  })

  describe('with TMDB validation matches', () => {
    const tmdbMatches = (id: number) => new Map([['heat|1995', { id, title: 'Heat' }]])
    const run2 = (plexTitle: string, validationId: number) => {
      const catalog: PlexCatalogOutput = {
        generated: '',
        library: library(),
        items: [item({ title: plexTitle, paths: [HEAT], external_ids: ['tmdb://949'] })],
      }
      const warnings = new WarningCollector()
      checkPlex({
        mediaType: 'movies',
        drive: 'Server',
        catalogs: [catalog],
        diskFiles: [HEAT],
        exists: () => true,
        folderPattern: MOVIE_FOLDER,
        tmdbMatches: tmdbMatches(validationId),
        rules: defaultPlexRules,
        warnings,
      })
      return warnings.all()
    }

    it('trusts agreeing ids over differing titles', () => {
      expect(run2('Heat: A Los Angeles Crime Saga', 949)).toEqual([])
    })

    it('reports disagreeing ids even when the titles are identical', () => {
      const warnings = run2('Heat', 12345)
      expect(warnings.map(w => w.type)).toEqual(['warn_plex_title_mismatch'])
      expect(warnings[0]!.issue).toMatch(/TMDB 949.*TMDB 12345/)
    })
  })

  it('does not flag unmatched audiobooks', () => {
    const chapter = 'Audible/Andy Weir/The Martian/01 - Chapter.mp3'
    expect(
      run({
        mediaType: 'audiobooks',
        folderPattern: null,
        lib: { media_type: 'audiobooks', agent: 'tv.plex.agents.music' },
        items: [
          item({ rating_key: 'al', type: 'album', title: 'The Martian', guid: 'local://1' }),
          item({ rating_key: 't', type: 'track', parent_rating_key: 'al', paths: [chapter] }),
        ],
        diskFiles: [chapter],
      })
    ).toEqual([])
  })

  it('reports a folder outside every library location once, at its top', () => {
    const warnings = run({
      mediaType: 'audiobooks',
      folderPattern: null,
      lib: {
        media_type: 'audiobooks',
        mapped_locations: [
          { plex_path: '/media/Audiobooks/Audible', drive: 'Server', library_path: 'Audible' },
        ],
      },
      items: [],
      diskFiles: [
        'Other Audible/Author/Book A/01 - One.mp3',
        'Other Audible/Author/Book B/01 - One.mp3',
      ],
    })
    expect(warnings.map(w => [w.type, w.path])).toEqual([
      ['warn_plex_folder_not_in_library', 'Other Audible'],
    ])
  })

  it('respects toggles and ignore lists', () => {
    const items = [item({ paths: [HEAT], guid: 'local://1' })]
    expect(run({ items, diskFiles: [HEAT], checks: { warn_plex_unmatched: false } })).toEqual([])
    expect(run({ items, diskFiles: [HEAT], ignored: { movies: ['Heat (1995)'] } })).toEqual([])
  })
})
