import { describe, it, expect } from 'vitest'

import {
  LogItemIndex,
  ResolvedLogEvent,
  checkPlexLogs,
  explainProblem,
  summarizeLogs,
} from '../../../src/plex/log-checks'
import { LogEvent, normalizeSignature } from '../../../src/plex/log-parser'
import { defaultPlexRules } from '../../../src/core/rules/plex'
import { WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import type { PlexCatalogItem, PlexCatalogOutput } from '../../../src/plex/types'

const EP1 = 'Other HD/Cougar Town (2009)/Season 02/Cougar Town (2009) - s02e01 - All Mixed Up.mp4'
const EP2 =
  'Other HD/Cougar Town (2009)/Season 02/Cougar Town (2009) - s02e02 - Let Yourself Go.mp4'

function item(overrides: Partial<PlexCatalogItem> & { paths?: string[] }): PlexCatalogItem {
  const { paths = [], ...rest } = overrides
  return {
    rating_key: 'k',
    type: 'episode',
    title: 'x',
    original_title: null,
    year: null,
    guid: null,
    external_ids: [],
    grandparent_rating_key: null,
    parent_rating_key: null,
    grandparent_title: null,
    parent_title: null,
    index: null,
    parent_index: null,
    duplicate: false,
    files: paths.map(p => ({
      plex_path: `/media/Shows/${p}`,
      drive: 'Server',
      library_path: p,
      deleted: false,
    })),
    ...rest,
  }
}

const catalog: PlexCatalogOutput = {
  generated: '',
  library: {
    key: '2',
    title: 'Shows',
    plex_type: 'show',
    slug: 'shows',
    agent: 'tv.plex.agents.series',
    locations: ['/media/Shows'],
    mapped_locations: [{ plex_path: '/media/Shows', drive: 'Server', library_path: '' }],
    media_type: 'shows',
    item_count: 0,
    collection_count: 0,
  },
  items: [
    item({ rating_key: 'show', type: 'show' }),
    item({
      rating_key: '77046',
      grandparent_rating_key: 'show',
      parent_rating_key: 'season',
      paths: [EP1],
    }),
    item({
      rating_key: '77047',
      grandparent_rating_key: 'show',
      parent_rating_key: 'season',
      paths: [EP2],
    }),
  ],
}

function event(overrides: Partial<LogEvent>): LogEvent {
  const message =
    overrides.message ??
    '[CreditsDetectionManager] Credits detection for item 77046 has failed too many times'
  return {
    family: 'Plex Media Server',
    timestamp: '2026-09-14 04:04:53.937',
    level: 'ERROR',
    component: 'CreditsDetectionManager',
    message,
    signature: normalizeSignature(message),
    ratingKey: null,
    plexPath: null,
    via: 'line',
    ...overrides,
  }
}

const index = new LogItemIndex([catalog])

describe('LogItemIndex', () => {
  it('resolves an item id to its files', () => {
    expect(index.resolve(event({ ratingKey: '77046' })).targets).toEqual([
      { mediaType: 'shows', drive: 'Server', libraryPath: EP1, isFile: true },
    ])
  })

  it('resolves a show id to the folders its episodes sit in', () => {
    expect(index.resolve(event({ ratingKey: 'show' })).targets).toEqual([
      {
        mediaType: 'shows',
        drive: 'Server',
        libraryPath: 'Other HD/Cougar Town (2009)/Season 02',
        isFile: false,
      },
    ])
  })

  it('resolves a server path, known file or not', () => {
    expect(index.resolve(event({ plexPath: `/media/Shows/${EP2}` })).targets[0]!.libraryPath).toBe(
      EP2
    )
    expect(index.resolve(event({ plexPath: '/media/Shows/Other SD/11.22.63' })).targets).toEqual([
      { mediaType: 'shows', drive: 'Server', libraryPath: 'Other SD/11.22.63', isFile: false },
    ])
  })

  it('flags ids the pull does not know', () => {
    const resolved = index.resolve(event({ ratingKey: '99999' }))
    expect(resolved.targets).toEqual([])
    expect(resolved.unknownItem).toBe(true)
  })

  it('lists the location prefixes to search log lines for', () => {
    expect(index.locationPrefixes).toEqual(['/media/Shows'])
  })
})

describe('explainProblem', () => {
  it('recognizes the common file problems', () => {
    expect(explainProblem(event({})).label).toBe('Credits detection failed')
    expect(
      explainProblem(
        event({
          message: '[CreditsDetectionManager] Detection is unsupported with multi-part media items',
        })
      ).label
    ).toMatch(/several files/)
    expect(
      explainProblem(
        event({ component: 'FFMPEG', message: '[FFMPEG] - stream 0, timescale not set' })
      ).label
    ).toMatch(/FFmpeg/)
    expect(explainProblem(event({ component: 'Other', message: '[Other] odd' })).label).toMatch(
      /logged a problem/
    )
  })
})

describe('checkPlexLogs', () => {
  const resolved = (overrides: Partial<LogEvent>): ResolvedLogEvent =>
    index.resolve(event(overrides))

  function run(
    events: ResolvedLogEvent[],
    opts: {
      ignored?: Record<string, string[]>
      drive?: string
      checks?: Partial<typeof defaultPlexRules.checks>
    } = {}
  ) {
    const warnings = new WarningCollector(parseIgnoreList(opts.ignored ?? {}, 'shows', 'test.yaml'))
    const landed = checkPlexLogs({
      mediaType: 'shows',
      drive: opts.drive ?? 'server',
      events,
      rules: { checks: { ...defaultPlexRules.checks, ...opts.checks } },
      warnings,
    })
    return { landed, warnings: warnings.all() }
  }

  it('groups one folder’s problems into one warning per level', () => {
    const { landed, warnings } = run([
      resolved({
        ratingKey: '77046',
        timestamp: '2026-09-14 04:04:53.936',
        message: '[CreditsDetectionManager] BufferingLineReader: failed to read line (error: -1)',
      }),
      resolved({ ratingKey: '77046', timestamp: '2026-09-14 04:04:53.937' }),
      resolved({ ratingKey: '77047', timestamp: '2026-09-14 04:05:09.415' }),
    ])
    expect(landed).toBe(3)
    expect(warnings.map(w => [w.type, w.path])).toEqual([
      ['warn_plex_log_error', 'Other HD/Cougar Town (2009)/Season 02'],
    ])
    const issue = warnings[0]!.issue
    expect(issue).toContain('Credits detection failed')
    expect(issue).toContain("'Cougar Town (2009) - s02e01 - All Mixed Up.mp4'")
    expect(issue).toContain('3 log line(s) from 2026-09-14 04:04:53.936 to 2026-09-14 04:05:09.415')
  })

  it('splits ERROR and WARN lines into their own warning types, WARN off by default', () => {
    const events = [
      resolved({ ratingKey: '77046' }),
      resolved({
        ratingKey: '77046',
        level: 'WARN',
        component: 'FFMPEG',
        message: '[FFMPEG] - stream 0, timescale not set',
      }),
    ]
    expect(run(events).warnings.map(w => w.type)).toEqual(['warn_plex_log_error'])
    expect(
      run(events, { checks: { warn_plex_log_warning: true } })
        .warnings.map(w => w.type)
        .sort()
    ).toEqual(['warn_plex_log_error', 'warn_plex_log_warning'])
  })

  it('leaves out events for other drives and unresolved events', () => {
    const { landed, warnings } = run(
      [resolved({ ratingKey: '77046' }), resolved({ ratingKey: null })],
      {
        drive: 'External',
      }
    )
    expect(landed).toBe(0)
    expect(warnings).toEqual([])
  })

  it('respects toggles and ignore lists', () => {
    const events = [resolved({ ratingKey: '77046' })]
    expect(run(events, { checks: { warn_plex_log_error: false } }).warnings).toEqual([])
    expect(run(events, { ignored: { shows: ['Cougar Town (2009)'] } }).warnings).toEqual([])
  })
})

describe('summarizeLogs', () => {
  it('counts each distinct problem and how much of it was tied to the library', () => {
    const summary = summarizeLogs(
      [
        index.resolve(event({ ratingKey: '77046', timestamp: '2026-09-14 04:00:00.000' })),
        index.resolve(
          event({
            ratingKey: '99999',
            timestamp: '2026-09-14 05:00:00.000',
            message:
              '[CreditsDetectionManager] Credits detection for item 99999 has failed too many times',
          })
        ),
        index.resolve(
          event({
            level: 'WARN',
            component: null,
            message: 'NAT: PMP, got an error: Not Supported by gateway.',
            via: null,
          })
        ),
      ],
      ['Plex Media Server.log']
    )
    expect(summary.totals).toEqual({ errors: 2, warnings: 1, tied_to_library: 1, unknown_items: 1 })
    expect(summary.covers).toEqual({
      from: '2026-09-14 04:00:00.000',
      to: '2026-09-14 05:00:00.000',
    })
    expect(summary.problems[0]).toMatchObject({ level: 'ERROR', count: 2, tied_to_library: 1 })
    expect(summary.problems[1]).toMatchObject({ level: 'WARN', count: 1, component: null })
  })
})
