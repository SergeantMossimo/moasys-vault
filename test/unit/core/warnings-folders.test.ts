import { describe, it, expect } from 'vitest'

import { WarningCollector } from '../../../src/core/types'
import type { WarningScope } from '../../../src/core/ignored'

/**
 * Folder grouping — the on-disk shape of every warnings file.
 *
 * The cases that matter are the ones where a warning's `path` is not a plain
 * category-anchored library path: the checks that span categories and pass a
 * display label, and the libraries with no `categories` at all. Those are the
 * rows that would otherwise land in the wrong entry or lose their location.
 */
describe('groupedByFolder', () => {
  const shows = (): WarningCollector => new WarningCollector({ mediaType: 'shows', entries: [] })

  it('returns nothing when nothing was collected', () => {
    expect(new WarningCollector().groupedByFolder()).toEqual([])
  })

  it('gathers every warning on one show into a single entry', () => {
    const wc = shows()
    wc.add('warn_quality_mismatch', 'SD/Good Eats (1999)/Season 09', 'a')
    wc.add('warn_missing_episode_title', 'SD/Good Eats (1999)/Season 09', 'b')
    wc.add('warn_episode_gaps', 'SD/Good Eats (1999)/Specials', 'c')

    const folders = wc.groupedByFolder()
    expect(folders).toHaveLength(1)
    expect(folders[0]?.path).toBe('SD/Good Eats (1999)')
    expect(folders[0]?.count).toBe(3)
    expect(folders[0]?.rows.map(r => r.type)).toEqual([
      'warn_missing_episode_title',
      'warn_quality_mismatch',
      'warn_episode_gaps',
    ])
  })

  it('strips the folder prefix from each row', () => {
    const wc = shows()
    wc.add('warn_quality_mismatch', 'SD/Good Eats (1999)/Season 09', 'a')
    expect(wc.groupedByFolder()[0]?.rows[0]?.path).toBe('Season 09')
  })

  it('omits the path on a row about the folder itself', () => {
    const wc = shows()
    wc.add('warn_show_year_mismatch', 'HD/Firefly (2002)', 'year')
    expect('path' in (wc.groupedByFolder()[0]?.rows[0] ?? {})).toBe(false)
  })

  it('sorts entries alphabetically by path, so runs diff cleanly', () => {
    const wc = shows()
    wc.add('warn_x', 'SD/Zulu (2000)', 'z')
    wc.add('warn_x', 'HD/Alpha (2002)', 'a')
    wc.add('warn_x', 'HD/Mike (2001)', 'm')
    expect(wc.groupedByFolder().map(f => f.path)).toEqual([
      'HD/Alpha (2002)',
      'HD/Mike (2001)',
      'SD/Zulu (2000)',
    ])
  })

  it('keeps one show per category rather than merging across them', () => {
    const wc = shows()
    wc.add('warn_x', 'HD/Firefly (2002)', 'a')
    wc.add('warn_x', 'SD/Firefly (2002)', 'b')
    expect(wc.groupedByFolder().map(f => f.path)).toEqual([
      'HD/Firefly (2002)',
      'SD/Firefly (2002)',
    ])
  })

  it('folds case so one show cannot split into two entries', () => {
    const wc = shows()
    wc.add('warn_x', 'HD/Firefly (2002)/Season 01', 'a')
    wc.add('warn_y', 'HD/firefly (2002)/Season 02', 'b')
    const folders = wc.groupedByFolder()
    expect(folders).toHaveLength(1)
    expect(folders[0]?.count).toBe(2)
  })

  describe('rows whose path is a display label', () => {
    // These pass an explicit `scope` because their `path` is a label, not a
    // real location — `deriveScope` would read it at the wrong level.
    const spanning: WarningScope = {
      categories: ['UHD', 'Other UHD'],
      levels: ['Firefly (2002)', 'Season 1'],
    }

    it('files the row under the first category and rebuilds the tail', () => {
      const wc = shows()
      wc.add('warn_duplicate_quality', 'Firefly (2002) — Season 1', 'dupe', { scope: spanning })

      const folder = wc.groupedByFolder()[0]
      expect(folder?.path).toBe('UHD/Firefly (2002)')
      expect(folder?.rows[0]?.path).toBe('Season 1')
      // The em-dash label is gone, and nothing it said was lost.
      expect(JSON.stringify(folder)).not.toContain('—')
    })

    it('merges a spanning row into the same entry as that show’s real paths', () => {
      const wc = shows()
      wc.add('warn_episode_gaps', 'UHD/Firefly (2002)/Season 01', 'gap')
      wc.add('warn_duplicate_quality', 'Firefly (2002) — Season 1', 'dupe', { scope: spanning })

      const folders = wc.groupedByFolder()
      expect(folders).toHaveLength(1)
      expect(folders[0]?.count).toBe(2)
    })

    it('drops the path when the label names only the folder', () => {
      const wc = new WarningCollector({ mediaType: 'movies', entries: [] })
      wc.add('warn_multi_quality', 'The Crow (1994)', 'multi', {
        scope: { categories: ['HD', 'Other HD'], levels: ['The Crow (1994)'] },
      })
      const folder = wc.groupedByFolder()[0]
      expect(folder?.path).toBe('HD/The Crow (1994)')
      expect('path' in (folder?.rows[0] ?? {})).toBe(false)
    })
  })

  describe('libraries without categories', () => {
    const flat = (): WarningCollector =>
      new WarningCollector({ mediaType: 'music', entries: [] }, false)

    it('treats the first segment as the artist, not a category', () => {
      const wc = flat()
      wc.add('warn_folder_tag_mismatch', 'Pink Floyd/The Wall', 'tag')
      const folder = wc.groupedByFolder()[0]
      // The whole path is the artist: with no categories there is no segment
      // above it, so nothing is stripped into one.
      expect(folder?.path).toBe('Pink Floyd')
      expect(folder?.rows[0]?.path).toBe('The Wall')
    })

    it('handles a warning at the library root without throwing', () => {
      const wc = flat()
      wc.add('permission_denied', '', 'cannot read root')
      const folder = wc.groupedByFolder()[0]
      expect(folder?.path).toBe('')
      expect(folder?.rows[0]?.issue).toBe('cannot read root')
    })
  })

  // The folder IS the category here, so its path is the bare category name —
  // which is what an ignore entry puts under `folders:` rather than `shows:`.
  it('uses the category as the path when a warning sits at a category root', () => {
    const wc = shows()
    wc.add('permission_denied', 'HD', 'cannot read')
    const folder = wc.groupedByFolder()[0]
    expect(folder?.path).toBe('HD')
    expect(folder?.rows[0]?.issue).toBe('cannot read')
  })

  describe('row ordering', () => {
    it('puts folder-level rows first, then relative paths, then type', () => {
      const wc = shows()
      wc.add('warn_quality_mismatch', 'HD/Show (2020)/Season 02', 'b')
      wc.add('warn_episode_gaps', 'HD/Show (2020)/Season 01', 'a')
      wc.add('warn_missing_episode_title', 'HD/Show (2020)/Season 01', 'a')
      wc.add('warn_show_year_mismatch', 'HD/Show (2020)', 'year')

      expect(wc.groupedByFolder()[0]?.rows.map(r => [r.path, r.type])).toEqual([
        [undefined, 'warn_show_year_mismatch'],
        ['Season 01', 'warn_episode_gaps'],
        ['Season 01', 'warn_missing_episode_title'],
        ['Season 02', 'warn_quality_mismatch'],
      ])
    })

    // The scan reads `Season 03` off disk; the TMDB pass builds `Season 3` from
    // the parsed number. Ordering on the canonical form is what keeps the two
    // findings about one season next to each other instead of a screen apart.
    it('sorts a zero-padded season next to its unpadded twin', () => {
      const wc = shows()
      wc.add('warn_quality_mismatch', 'SD/Show (2010)/Season 10', 'ten')
      wc.add('warn_tmdb_episode_count', 'SD/Show (2010)/Season 3', 'three unpadded')
      wc.add('warn_missing_episode_title', 'SD/Show (2010)/Season 03', 'three padded')

      expect(wc.groupedByFolder()[0]?.rows.map(r => r.path)).toEqual([
        'Season 03',
        'Season 3',
        'Season 10',
      ])
    })
  })

  // A folder entry carries only what locates the problem, and nothing that
  // restates another field. The remedy and the ignore suggestion are the same
  // text for every row of a type, which is what buried the facts that differ;
  // the remedy's home is docs/OUTPUT.md. The folder's name and category are
  // segments of `path`, and its distinct types are one pass over `rows`.
  it('carries no fix text, ignore entry, internal scope, or restated fields', () => {
    const wc = shows()
    wc.add('warn_x', 'HD/Firefly (2002)/Season 01', 'gap', { fix: 'Do it.' })
    const folder = wc.groupedByFolder()[0]

    expect(Object.keys(folder ?? {})).toEqual(['path', 'count', 'rows'])
    expect(Object.keys(folder?.rows[0] ?? {})).toEqual(['type', 'path', 'issue'])
    expect(JSON.stringify(folder)).not.toContain('Do it.')
  })
})
