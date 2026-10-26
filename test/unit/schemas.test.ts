/**
 * The hand-written JSON Schemas in schemas/ against what the code actually
 * writes. Each output is built by the real code from a small fixture — the
 * same functions the runners call — and validated, so a field added to an
 * output type without its schema (or the reverse) fails here rather than in
 * someone's downstream consumer.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Ajv2020 from 'ajv/dist/2020'

import { writeWarnings } from '../../src/core/runner-shared'
import { scan } from '../../src/core/scanner'
import { WarningCollector } from '../../src/core/types'
import { mergeWarnings } from '../../src/core/warnings-merge'
import { defaultAudiobooksRules } from '../../src/core/rules/audiobooks'
import { defaultMoviesRules } from '../../src/core/rules/movies'
import { defaultMusicRules } from '../../src/core/rules/music'
import { defaultShowsRules } from '../../src/core/rules/shows'
import { createAudiobooksModule } from '../../src/media/audiobooks'
import { createMoviesModule } from '../../src/media/movies'
import { createMusicModule } from '../../src/media/music'
import { createShowsModule } from '../../src/media/shows'
import { toCatalogItem, toCollection } from '../../src/plex/catalog'
import { LogItemIndex, summarizeLogs } from '../../src/plex/log-checks'
import { normalizeSignature } from '../../src/plex/log-parser'
import type { CollectionJournal } from '../../src/plex/collections'
import { PathMapper, rootRefs } from '../../src/plex/paths'
import type {
  PlexCatalogOutput,
  PlexCollectionsOutput,
  PlexLibrariesOutput,
  PlexLibrarySummary,
} from '../../src/plex/types'
import { JsonCache } from '../../src/validate/cache'
import { validateAudiobooks } from '../../src/validate/audiobooks'
import { validateMovies } from '../../src/validate/movies'
import { validateShows } from '../../src/validate/shows'
import type { OpenLibraryClient } from '../../src/validate/openlibrary'
import type { TmdbClient } from '../../src/validate/tmdb'
import { buildLibrary, cleanupLibrary } from '../fixtures/library'

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas')

// ─────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────

const ajv = new Ajv2020({ allErrors: true })
// Only `date-time` is used; what's written is always `new Date().toISOString()`.
ajv.addFormat('date-time', s => !Number.isNaN(Date.parse(s)))
for (const file of fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.json'))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8')), file)
}

/** Validate against schemas/<file>, failing with Ajv's messages. */
function expectValid(file: string, data: unknown): void {
  const validate = ajv.getSchema(file)
  if (!validate) throw new Error(`no schema ${file}`)
  // A round trip through JSON, so the check sees exactly what lands on disk.
  const onDisk = JSON.parse(JSON.stringify(data))
  const ok = validate(onDisk)
  expect(ok ? [] : validate.errors, file).toEqual([])
}

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const roots: string[] = []
let tmpDir: string

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-schemas-'))
})

afterAll(() => {
  vi.restoreAllMocks()
  for (const root of roots) cleanupLibrary(root)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function library(spec: Parameters<typeof buildLibrary>[0]): string {
  const root = buildLibrary(spec, 'moasys-schemas-lib-')
  roots.push(root)
  return root
}

const memoryCache = <T>() => new JsonCache<T>(path.join(tmpDir, `none-${Math.random()}.json`))

// ─────────────────────────────────────────────
// Catalogs and warnings
// ─────────────────────────────────────────────

describe('the validator itself', () => {
  it('rejects a field the schema does not know, so a passing test means something', () => {
    const validate = ajv.getSchema('movies.json')!
    const movie = {
      title: 'Heat',
      year: 1995,
      edition: null,
      tmdb_id: null,
      folder: 'Heat (1995)',
      versions: [],
    }
    expect(validate([{ ...movie, versions: [{ category: 'HD', quality: 'HD' }] }])).toBe(true)
    expect(validate([{ ...movie, versions: [{ category: 'HD', quality: 'HD' }], extra: 1 }])).toBe(
      false
    )
  })
})

describe('catalog schemas', () => {
  it('movies.json', () => {
    const root = library({
      HD: {
        'Heat (1995) {tmdb-949}': {
          'Heat (1995).mp4': '',
          "Heat (1995) {edition-Director's Cut}.mp4": '',
        },
      },
    })
    const module = createMoviesModule({ ...defaultMoviesRules, categories: [{ name: 'HD' }] })
    expectValid(
      'movies.json',
      module.serialize(scan({ root_path: root }, module, new WarningCollector(), new Map()))
    )
  })

  it('shows.json', () => {
    const root = library({
      'Firefly (2002) {tmdb-1437}': {
        'Season 01': {
          'Firefly (2002) - s01e01 - Serenity.mp4': '',
          'Firefly (2002) - s01e02-e03 - Train Job.mp4': '',
        },
        Specials: { 'Firefly (2002) - s00e01.mp4': '' },
      },
    })
    const module = createShowsModule(defaultShowsRules)
    expectValid(
      'shows.json',
      module.serialize(scan({ root_path: root }, module, new WarningCollector(), new Map()))
    )
  })

  it('music.json', () => {
    const root = library({ Artist: { Album: { '01 - Song.flac': '', '102 - Song.flac': '' } } })
    const module = createMusicModule(defaultMusicRules)
    expectValid(
      'music.json',
      module.serialize(scan({ root_path: root }, module, new WarningCollector(), new Map()))
    )
  })

  it('audiobooks.json', () => {
    const root = library({
      'Douglas Preston & Lincoln Child': { Relic: { '01 - Chapter.mp3': '' } },
    })
    const module = createAudiobooksModule(defaultAudiobooksRules)
    expectValid(
      'audiobooks.json',
      module.serialize(scan({ root_path: root }, module, new WarningCollector(), new Map()))
    )
  })
})

describe('warnings schemas', () => {
  function warningsFile(): unknown {
    const warnings = new WarningCollector({ mediaType: 'shows', entries: [] })
    warnings.add('warn_bad_show_folder', 'HD/Firefly', "Folder name is not 'Show Title (YEAR)'.")
    warnings.add('warn_episode_gaps', 'HD/Firefly (2002)/Season 01', 'Missing E04.')
    warnings.add('warn_non_primary', 'HD/Firefly (2002)/Season 01/x.mkv', 'Non-primary.', {
      extension: '.mkv',
    })
    const file = path.join(tmpDir, `warnings-${Math.random()}.json`)
    writeWarnings(file, warnings)
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }

  it('warnings.json', () => {
    expectValid('warnings.json', warningsFile())
  })

  it('all-warnings.json', () => {
    const scanned = warningsFile() as Parameters<typeof mergeWarnings>[0][number]['data']
    const merged = mergeWarnings(
      [
        { command: 'scan', file: 'warnings.json', rerun: 'npm run shows', data: scanned },
        {
          command: 'validate',
          file: 'validation-warnings.json',
          rerun: 'npm run validate:shows',
          data: null,
        },
      ],
      { mediaType: 'shows', drive: 'server' }
    )
    expectValid('all-warnings.json', merged)
  })
})

// ─────────────────────────────────────────────
// Validation results
// ─────────────────────────────────────────────

describe('validation schemas', () => {
  it('validation-movies.json', async () => {
    const client = {
      searchMovie: async () => [
        {
          id: 949,
          title: 'Heat',
          original_title: 'Heat',
          release_date: '1995-12-15',
          popularity: 50,
        },
      ],
      getMovie: async () => ({
        id: 949,
        title: 'Heat',
        original_title: 'Heat',
        release_date: '1995-12-15',
        runtime: 170,
      }),
    } as unknown as TmdbClient
    const result = await validateMovies(
      [
        {
          title: 'Heat',
          year: 1995,
          edition: null,
          tmdb_id: null,
          folder: 'Heat (1995)',
          versions: [],
        },
      ],
      defaultMoviesRules,
      client,
      memoryCache(),
      memoryCache(),
      new WarningCollector()
    )
    expect(result).toHaveLength(1)
    expectValid('validation-movies.json', result)
  })

  it('validation-shows.json', async () => {
    const details = {
      id: 1437,
      name: 'Firefly',
      original_name: 'Firefly',
      first_air_date: '2002-09-20',
      number_of_seasons: 1,
      number_of_episodes: 14,
      seasons: [{ season_number: 1, episode_count: 14, name: 'Season 1', air_date: '2002-09-20' }],
    }
    const client = {
      searchShow: async () => [
        {
          id: 1437,
          name: 'Firefly',
          original_name: 'Firefly',
          first_air_date: '2002-09-20',
          popularity: 50,
        },
      ],
      getShow: async () => details,
      getShowSeason: async () => ({
        season_number: 1,
        episodes: [{ episode_number: 1, name: 'Serenity' }],
      }),
    } as unknown as TmdbClient
    const result = await validateShows(
      [
        {
          title: 'Firefly',
          year: 2002,
          edition: null,
          tmdb_id: null,
          tvdb_id: null,
          seasons: [
            {
              season: '1',
              episode_count: 1,
              episodes: [{ episode_start: 1, episode_end: 1, title: 'Serenity' }],
              versions: [{ category: 'HD', quality: 'HD' }],
            },
          ],
        },
      ],
      defaultShowsRules,
      client,
      memoryCache(),
      memoryCache(),
      memoryCache(),
      new WarningCollector()
    )
    expect(result).toHaveLength(1)
    expectValid('validation-shows.json', result)
  })

  it('validation-audiobooks.json', async () => {
    const client = {
      search: async () => [
        {
          key: '/works/OL1W',
          title: 'Relic',
          author_name: ['Douglas Preston', 'Lincoln Child'],
          first_publish_year: 1995,
        },
      ],
    } as unknown as OpenLibraryClient
    const result = await validateAudiobooks(
      [
        {
          title: 'Relic',
          authors: ['Douglas Preston', 'Lincoln Child'],
          author_folder: 'Douglas Preston & Lincoln Child',
          chapter_count: 1,
          versions: [{ category: 'default', quality: 'MP3' }],
        },
      ],
      defaultAudiobooksRules,
      client,
      memoryCache(),
      new WarningCollector()
    )
    expect(result).toHaveLength(1)
    expectValid('validation-audiobooks.json', result)
  })
})

// ─────────────────────────────────────────────
// Plex
// ─────────────────────────────────────────────

describe('Plex schemas', () => {
  const generated = new Date().toISOString()
  const section = {
    key: '1',
    type: 'show',
    title: 'TV Shows',
    agent: 'tv.plex.agents.series',
    Location: [{ id: 1, path: '/media/Shows' }],
  }
  const mapper = new PathMapper(rootRefs({ shows: [{ root_path: 'M:\\Shows', name: 'Server' }] }), [
    section,
  ])
  // Built the way plex:pull builds it (src/plex/pull.ts).
  const summary: PlexLibrarySummary = {
    key: section.key,
    title: section.title,
    plex_type: section.type,
    slug: 'tv-shows',
    agent: section.agent,
    locations: ['/media/Shows'],
    mapped_locations: [{ plex_path: '/media/Shows', drive: 'Server', library_path: '' }],
    media_type: mapper.sectionMediaType(section),
    item_count: 1,
    collection_count: 1,
  }
  const episode = toCatalogItem(
    {
      ratingKey: '101',
      type: 'episode',
      title: 'Serenity',
      year: 2002,
      guid: 'plex://episode/5d9c',
      Guid: [{ id: 'tmdb://123' }],
      grandparentRatingKey: '100',
      parentRatingKey: '99',
      grandparentTitle: 'Firefly',
      parentTitle: 'Season 1',
      index: 1,
      parentIndex: 1,
      Media: [
        {
          id: 1,
          Part: [
            {
              id: 1,
              file: '/media/Shows/Firefly (2002)/Season 01/Firefly (2002) - s01e01.mp4',
              size: 10,
            },
          ],
        },
      ],
    },
    'episode',
    mapper,
    new Set()
  )

  it('plex-libraries.json', () => {
    const libraries: PlexLibrariesOutput = {
      generated,
      server: { machine_identifier: 'abc123', version: '1.41.0' },
      libraries: [summary],
    }
    expectValid('plex-libraries.json', libraries)
  })

  it('plex-catalog.json', () => {
    const catalog: PlexCatalogOutput = { generated, library: summary, items: [episode] }
    expectValid('plex-catalog.json', catalog)
  })

  it('plex-collections.json', () => {
    const collections: PlexCollectionsOutput = {
      generated,
      library: { key: summary.key, title: summary.title, slug: summary.slug },
      collections: [
        toCollection(
          { ratingKey: '500', type: 'collection', title: 'Whedon', subtype: 'show', smart: '0' },
          [{ ratingKey: '100', type: 'show', title: 'Firefly', year: 2002 }]
        ),
      ],
    }
    expectValid('plex-collections.json', collections)
  })

  it('plex-collection-changes.json', () => {
    const journal: CollectionJournal = {
      generated,
      mode: 'apply',
      library: { key: summary.key, title: summary.title, slug: summary.slug },
      server: 'abc123',
      source: 'output/plex/tv-shows/collection-review.md',
      operations: [
        {
          kind: 'create',
          collection: 'Whedon',
          collection_key: '600',
          rating_keys: ['100'],
          items: ['Firefly (2002)'],
          status: 'done',
        },
        {
          kind: 'remove',
          collection: 'Whedon',
          collection_key: null,
          rating_keys: ['101'],
          items: ['Dollhouse (2009)'],
          status: 'failed',
          error: 'Plex HTTP 500',
        },
      ],
    }
    expectValid('plex-collection-changes.json', journal)
  })

  it('plex-logs-summary.json', () => {
    const index = new LogItemIndex([{ generated, library: summary, items: [episode] }])
    const message =
      '[CreditsDetectionManager] Credits detection for item 101 has failed too many times'
    const event = index.resolve({
      family: 'Plex Media Server',
      timestamp: '2026-09-14 04:04:53.937',
      level: 'ERROR',
      component: 'CreditsDetectionManager',
      message,
      signature: normalizeSignature(message),
      ratingKey: '101',
      plexPath: null,
      via: 'line',
    })
    expectValid('plex-logs-summary.json', {
      generated,
      ...summarizeLogs([event], ['Plex Media Server.log']),
    })
  })
})
