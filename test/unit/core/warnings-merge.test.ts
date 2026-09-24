import { describe, it, expect } from 'vitest'

import { describeSources, isWarningsOutput, mergeWarnings } from '../../../src/core/warnings-merge'
import type { MergeInput } from '../../../src/core/warnings-merge'
import type { WarningFolder, WarningsOutput } from '../../../src/core/types'

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

function output(generated: string, folders: WarningFolder[]) {
  const count = folders.reduce((n, f) => n + f.rows.length, 0)
  const by_type: Record<string, number> = {}
  for (const row of folders.flatMap(f => f.rows)) by_type[row.type] = (by_type[row.type] ?? 0) + 1
  return { generated, count, folder_count: folders.length, by_type, folders }
}

function folder(partial: Partial<WarningFolder> & Pick<WarningFolder, 'path'>) {
  const rows = partial.rows ?? []
  return {
    count: rows.length,
    ...partial,
    rows,
  } as WarningFolder
}

const SCAN_AT = '2026-09-18T18:00:00.000Z'
const LATER = '2026-09-18T19:00:00.000Z'
const EARLIER = '2026-09-18T17:00:00.000Z'

function source(
  command: string,
  data: WarningsOutput | null,
  extra: Partial<MergeInput> = {}
): MergeInput {
  return { command, file: `${command}.json`, rerun: `npm run ${command} external`, data, ...extra }
}

const shows = { mediaType: 'shows' as const, drive: 'external' }

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('isWarningsOutput', () => {
  it('accepts the current shape', () => {
    expect(isWarningsOutput(output(SCAN_AT, []))).toBe(true)
  })

  it('rejects a file left by a version before the folder regrouping', () => {
    // It parses fine and has a plausible `count`, so without a shape check it
    // would silently contribute nothing at all.
    const old = { generated: SCAN_AT, count: 429, by_type: { warn_x: { items: [] } } }
    expect(isWarningsOutput(old)).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isWarningsOutput(null)).toBe(false)
    expect(isWarningsOutput('{}')).toBe(false)
  })
})

describe('describeSources', () => {
  it('reports a missing source as null, never zero', () => {
    // The whole point of the block: a command that never ran must not read as
    // a clean library.
    const sources = describeSources([source('validate', null, { problem: 'missing' })])
    expect(sources[0]?.status).toBe('missing')
    expect(sources[0]?.count).toBeNull()
    expect(sources[0]?.generated).toBeNull()
    expect(sources[0]?.note).toContain('npm run validate external')
    expect(sources[0]?.note).toContain('Nothing from this command')
  })

  it('flags a source older than the scan as stale but still folds it in', () => {
    const sources = describeSources([
      source('scan', output(SCAN_AT, [])),
      source('validate', output(EARLIER, [])),
    ])
    expect(sources[1]?.status).toBe('stale')
    expect(sources[1]?.note).toContain('Older than the scan')
    expect(sources[1]?.count).toBe(0)
  })

  it('does not flag a source newer than the scan', () => {
    const sources = describeSources([
      source('scan', output(SCAN_AT, [])),
      source('validate', output(LATER, [])),
    ])
    expect(sources[1]?.status).toBe('ok')
    expect('note' in (sources[1] ?? {})).toBe(false)
  })

  it('flags nothing stale when the scan itself is absent', () => {
    // Staleness is undecidable without the reference timestamp, so guessing
    // would mean flagging every other source on a drive that was never scanned.
    const sources = describeSources([
      source('scan', null, { problem: 'missing' }),
      source('validate', output(EARLIER, [])),
    ])
    expect(sources[0]?.status).toBe('missing')
    expect(sources[1]?.status).toBe('ok')
  })

  // Every note names a command to run, so a source whose command doesn't exist
  // must not be listed at all — see VALIDATES in src/report.ts. This asserts
  // the contract the notes depend on.
  it('names a runnable command in every note', () => {
    const sources = describeSources([
      source('scan', null, { problem: 'missing' }),
      source('plex:check', null, { problem: 'unreadable', detail: 'bad' }),
    ])
    for (const s of sources) {
      expect(s.note).toContain(`npm run ${s.command} external`)
    }
  })

  it('explains an unreadable source and keeps its detail', () => {
    const sources = describeSources([
      source('scan', null, { problem: 'unreadable', detail: 'written by an older version' }),
    ])
    expect(sources[0]?.status).toBe('unreadable')
    expect(sources[0]?.count).toBeNull()
    expect(sources[0]?.note).toContain('written by an older version')
  })
})

describe('mergeWarnings', () => {
  it('folds one show’s rows from two commands into a single entry', () => {
    const scan = output(SCAN_AT, [
      folder({
        path: 'SD/Bake Off (2010)',
        rows: [{ type: 'warn_missing_episode_title', path: 'Season 03', issue: 'no titles' }],
      }),
    ])
    const validate = output(LATER, [
      folder({
        path: 'SD/Bake Off (2010)',
        rows: [{ type: 'warn_tmdb_episode_count', path: 'Season 3', issue: '4 missing' }],
      }),
    ])

    const merged = mergeWarnings([source('scan', scan), source('validate', validate)], shows)
    expect(merged.folder_count).toBe(1)
    expect(merged.count).toBe(2)
    expect(merged.folders[0]?.commands).toEqual(['scan', 'validate'])
    expect(merged.folders[0]?.rows.map(r => r.type)).toEqual([
      'warn_missing_episode_title',
      'warn_tmdb_episode_count',
    ])
  })

  // The scan reads `Season 03` off disk; the TMDB pass builds `Season 3` from
  // the parsed number. Both describe one season, and the point of the merge is
  // that they end up next to each other.
  it('sorts a zero-padded season adjacent to its unpadded twin from another source', () => {
    const scan = output(SCAN_AT, [
      folder({
        path: 'SD/Show (2010)',
        rows: [
          { type: 'warn_quality_mismatch', path: 'Season 10', issue: 'ten' },
          { type: 'warn_missing_episode_title', path: 'Season 03', issue: 'padded three' },
        ],
      }),
    ])
    const validate = output(LATER, [
      folder({
        path: 'SD/Show (2010)',
        rows: [{ type: 'warn_tmdb_episode_count', path: 'Season 3', issue: 'unpadded three' }],
      }),
    ])

    const merged = mergeWarnings([source('scan', scan), source('validate', validate)], shows)
    expect(merged.folders[0]?.rows.map(r => [r.path, r.command])).toEqual([
      ['Season 03', 'scan'],
      ['Season 3', 'validate'],
      ['Season 10', 'scan'],
    ])
  })

  it('keeps both findings rather than deduplicating them', () => {
    // Two detectors reporting the same season are two things to act on.
    const rows = [{ type: 'warn_x', path: 'Season 01', issue: 'same' }]
    const merged = mergeWarnings(
      [
        source('scan', output(SCAN_AT, [folder({ path: 'SD/A (2001)', rows })])),
        source('validate', output(LATER, [folder({ path: 'SD/A (2001)', rows })])),
      ],
      shows
    )
    expect(merged.folders[0]?.rows).toHaveLength(2)
    expect(merged.count).toBe(2)
  })

  it('folds a case-different folder name onto one entry', () => {
    const merged = mergeWarnings(
      [
        source(
          'scan',
          output(SCAN_AT, [
            folder({
              path: 'SD/Firefly (2002)',
              rows: [{ type: 'warn_x', issue: 'a' }],
            }),
          ])
        ),
        source(
          'validate',
          output(LATER, [
            folder({
              path: 'SD/firefly (2002)',
              rows: [{ type: 'warn_y', issue: 'b' }],
            }),
          ])
        ),
      ],
      shows
    )
    expect(merged.folder_count).toBe(1)
    expect(merged.folders[0]?.count).toBe(2)
  })

  it('keeps the same show in two categories apart', () => {
    const merged = mergeWarnings(
      [
        source(
          'scan',
          output(SCAN_AT, [
            folder({
              path: 'HD/Firefly (2002)',
              rows: [{ type: 'warn_x', issue: 'a' }],
            }),
            folder({
              path: 'SD/Firefly (2002)',
              rows: [{ type: 'warn_x', issue: 'b' }],
            }),
          ])
        ),
      ],
      shows
    )
    expect(merged.folders.map(f => f.path)).toEqual(['HD/Firefly (2002)', 'SD/Firefly (2002)'])
  })

  it('sorts entries alphabetically and sums the tallies', () => {
    const merged = mergeWarnings(
      [
        source(
          'scan',
          output(SCAN_AT, [
            folder({
              path: 'SD/Zulu (2000)',
              rows: [{ type: 'warn_a', issue: 'z' }],
            }),
            folder({
              path: 'HD/Alpha (2002)',
              rows: [
                { type: 'warn_a', issue: 'x' },
                { type: 'warn_b', issue: 'y' },
              ],
            }),
          ])
        ),
      ],
      shows
    )
    expect(merged.folders.map(f => f.path)).toEqual(['HD/Alpha (2002)', 'SD/Zulu (2000)'])
    // Worst first.
    expect(merged.by_type).toEqual({ warn_a: 2, warn_b: 1 })
    expect(Object.keys(merged.by_type)).toEqual(['warn_a', 'warn_b'])
  })

  it('carries no fix text or ignore entries through the merge', () => {
    const merged = mergeWarnings(
      [
        source(
          'scan',
          output(SCAN_AT, [
            folder({
              path: 'SD/A (2001)',
              rows: [{ type: 'warn_x', path: 'Season 01', issue: 'a' }],
            }),
          ])
        ),
      ],
      shows
    )
    expect('fixes' in merged).toBe(false)
    expect(Object.keys(merged.folders[0] ?? {})).toEqual(['path', 'count', 'commands', 'rows'])
    expect(Object.keys(merged.folders[0]?.rows[0] ?? {})).toEqual([
      'command',
      'type',
      'path',
      'issue',
    ])
  })

  it('contributes nothing from a missing or unreadable source', () => {
    const merged = mergeWarnings(
      [
        source(
          'scan',
          output(SCAN_AT, [
            folder({
              path: 'SD/A (2001)',
              rows: [{ type: 'warn_x', issue: 'a' }],
            }),
          ])
        ),
        source('validate', null, { problem: 'missing' }),
        source('plex:check', null, { problem: 'unreadable', detail: 'bad JSON' }),
      ],
      shows
    )
    expect(merged.count).toBe(1)
    expect(merged.sources.map(s => s.status)).toEqual(['ok', 'missing', 'unreadable'])
  })

  it('still produces a usable file when no source could be read', () => {
    const merged = mergeWarnings(
      [
        source('scan', null, { problem: 'missing' }),
        source('validate', null, { problem: 'missing' }),
      ],
      shows
    )
    expect(merged.folders).toEqual([])
    expect(merged.count).toBe(0)
    expect(merged.folder_count).toBe(0)
    // The sources block still explains every one of them.
    expect(merged.sources).toHaveLength(2)
    expect(merged.sources.every(s => s.note !== undefined)).toBe(true)
  })

  it('records the drive and media type it describes', () => {
    const merged = mergeWarnings([source('scan', output(SCAN_AT, []))], shows)
    expect(merged.drive).toBe('external')
    expect(merged.media_type).toBe('shows')
    expect(merged.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('orders commands by the pipeline, not alphabetically', () => {
    const rows = [{ type: 'warn_x', issue: 'a' }]
    const merged = mergeWarnings(
      [
        source('scan', output(SCAN_AT, [folder({ path: 'SD/A (2001)', rows })])),
        source('validate', output(LATER, [folder({ path: 'SD/A (2001)', rows })])),
        source('plex:check', output(LATER, [folder({ path: 'SD/A (2001)', rows })])),
      ],
      shows
    )
    expect(merged.folders[0]?.commands).toEqual(['scan', 'validate', 'plex:check'])
  })
})
