import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  parseRunnerArgs,
  resolveRoot,
  rootNames,
  writeJsonOutput,
  writeWarnings,
} from '../../../src/core/runner-shared'
import { MediaRootConfig, WarningCollector } from '../../../src/core/types'
import { parseIgnoreList } from '../../../src/core/ignored'
import type { IgnoreMediaType } from '../../../src/core/ignored'

/** Build an ignore list the way a real file parses, for collector tests. */
function ignoreList(mediaType: IgnoreMediaType, raw: Record<string, string[]>) {
  return parseIgnoreList(raw, mediaType, 'test.yaml')
}

const VALID_TYPES = ['movies', 'shows', 'music', 'audiobooks'] as const

describe('parseRunnerArgs', () => {
  let originalArgv: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalArgv = process.argv
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.argv = originalArgv
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  function setArgv(...args: string[]) {
    process.argv = ['node', 'script.js', ...args]
  }

  it('returns implicit help when no flags are provided', () => {
    setArgv()
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'help', explicit: false })
  })

  it('returns explicit help for --help', () => {
    setArgv('--help')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'help', explicit: true })
  })

  it('returns explicit help for -h', () => {
    setArgv('-h')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'help', explicit: true })
  })

  it('returns all-mode for --all', () => {
    setArgv('--all')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'all' })
  })

  it('returns one-mode for --type movies', () => {
    setArgv('--type', 'movies')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'one', type: 'movies' })
  })

  it('accepts each valid type', () => {
    for (const t of VALID_TYPES) {
      setArgv('--type', t)
      expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'one', type: t })
    }
  })

  it('exits when --type value is missing', () => {
    setArgv('--type')
    expect(() => parseRunnerArgs(VALID_TYPES)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid type/i))
  })

  it('exits when --type value is not in the validTypes list', () => {
    setArgv('--type', 'photos')
    expect(() => parseRunnerArgs(VALID_TYPES)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Choices:/))
  })

  it('exits when an unknown flag is passed', () => {
    setArgv('--quiet')
    expect(() => parseRunnerArgs(VALID_TYPES)).toThrow('process.exit called')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown flag/i))
  })

  // npm forwards bare positionals, so `npm run movies external` reaches the
  // script as `--type movies external`.
  it('reads a trailing drive name after --type <value>', () => {
    setArgv('--type', 'movies', 'external')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({
      kind: 'one',
      type: 'movies',
      drive: 'external',
    })
  })

  it('reads a trailing drive name after --all', () => {
    setArgv('--all', 'external')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({ kind: 'all', drive: 'external' })
  })

  it('does not mistake the type value for a drive name', () => {
    setArgv('--type', 'movies')
    const parsed = parseRunnerArgs(VALID_TYPES)
    expect(parsed).toEqual({ kind: 'one', type: 'movies', drive: undefined })
  })

  it('skips flags when looking for the drive positional', () => {
    setArgv('--type', 'movies', '--refresh-older-than=30d', 'external')
    expect(parseRunnerArgs(VALID_TYPES)).toEqual({
      kind: 'one',
      type: 'movies',
      drive: 'external',
    })
  })
})

describe('resolveRoot', () => {
  const roots: MediaRootConfig[] = [
    { root_path: 'M:\\Movies', name: 'Server' },
    { root_path: 'D:\\Movies', name: 'External' },
  ]

  it('returns the first root when no drive is named', () => {
    expect(resolveRoot(roots, undefined)).toEqual(roots[0])
  })

  it('matches a named drive', () => {
    expect(resolveRoot(roots, 'External')).toEqual(roots[1])
  })

  it('matches case-insensitively', () => {
    expect(resolveRoot(roots, 'external')).toEqual(roots[1])
    expect(resolveRoot(roots, 'EXTERNAL')).toEqual(roots[1])
  })

  it('returns null for an unknown drive rather than falling back', () => {
    expect(resolveRoot(roots, 'nas')).toBeNull()
  })

  it('returns null when there are no roots at all', () => {
    expect(resolveRoot([], undefined)).toBeNull()
  })
})

describe('rootNames', () => {
  it('joins the configured names for error messages', () => {
    expect(
      rootNames([
        { root_path: 'M:\\Movies', name: 'Server' },
        { root_path: 'D:\\Movies', name: 'External' },
      ])
    ).toBe('Server, External')
  })

  it('returns an empty string for no roots', () => {
    expect(rootNames([])).toBe('')
  })
})

describe('writeJsonOutput', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-write-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('writes pretty-printed JSON', () => {
    const out = path.join(tmpDir, 'data.json')
    writeJsonOutput(out, { hello: 'world' })
    const content = fs.readFileSync(out, 'utf-8')
    expect(content).toContain('\n')
    expect(JSON.parse(content)).toEqual({ hello: 'world' })
  })

  it('creates parent directories that do not exist', () => {
    const out = path.join(tmpDir, 'nested', 'sub', 'data.json')
    writeJsonOutput(out, { hello: 'world' })
    expect(fs.existsSync(out)).toBe(true)
  })

  it('logs item count for arrays', () => {
    const out = path.join(tmpDir, 'list.json')
    writeJsonOutput(out, [1, 2, 3])
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/3 entries/))
  })

  it('omits the entry count for non-array outputs', () => {
    const out = path.join(tmpDir, 'obj.json')
    writeJsonOutput(out, { a: 1 })
    expect(logSpy).toHaveBeenCalledWith(expect.not.stringMatching(/entries/))
  })
})

describe('writeWarnings', () => {
  let tmpDir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moasys-warn-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    logSpy.mockRestore()
  })

  it('writes a warnings file grouped by folder', () => {
    const out = path.join(tmpDir, 'warnings.json')
    const warnings = new WarningCollector()
    warnings.add('warn_bad_file_name', 'HD/Firefly (2002)/ep.mp4', 'bad name')

    writeWarnings(out, warnings)
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'))
    expect(parsed.count).toBe(1)
    expect(parsed.folder_count).toBe(1)
    expect(parsed.by_type).toEqual({ warn_bad_file_name: 1 })
    expect(parsed.folders).toEqual([
      {
        path: 'HD/Firefly (2002)',
        count: 1,
        rows: [{ type: 'warn_bad_file_name', path: 'ep.mp4', issue: 'bad name' }],
      },
    ])
    expect(parsed.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 8601
  })

  it('writes an empty folders array when no warnings were collected', () => {
    const out = path.join(tmpDir, 'warnings.json')
    writeWarnings(out, new WarningCollector())
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'))
    expect(parsed.count).toBe(0)
    expect(parsed.folder_count).toBe(0)
    expect(parsed.folders).toEqual([])
    expect(parsed.by_type).toEqual({})
  })

  // Neither the remedy nor the ignore suggestion is written any more — both
  // were the same text on every row of a type, which is what buried the facts.
  it('writes neither fix text nor ignore entries', () => {
    const out = path.join(tmpDir, 'warnings.json')
    const warnings = new WarningCollector({ mediaType: 'shows', entries: [] })
    warnings.add('warn_q', 'HD/A (2001)/Season 01', 'first', { fix: 'Do the thing.' })

    writeWarnings(out, warnings)
    const text = fs.readFileSync(out, 'utf-8')
    expect(text).not.toContain('Do the thing.')
    expect(text).not.toContain('ignore')
    expect(text).not.toContain('fixes')
  })

  it('preserves the optional extension field on individual warnings', () => {
    const out = path.join(tmpDir, 'warnings.json')
    const warnings = new WarningCollector()
    warnings.add('warn_non_primary', 'HD/Movie (1999)/file.mkv', 'Non-MP4', { extension: '.mkv' })

    writeWarnings(out, warnings)
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'))
    expect(parsed.folders[0].rows[0].extension).toBe('.mkv')
  })

  it('logs the warning count and the folder count', () => {
    const out = path.join(tmpDir, 'warnings.json')
    const warnings = new WarningCollector()
    warnings.add('warn_a', 'HD/A (2001)', '1')
    warnings.add('warn_b', 'HD/B (2002)', '2')
    writeWarnings(out, warnings)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/2 warnings across 2 folders/))
  })
})

describe('WarningCollector', () => {
  it('starts empty', () => {
    const wc = new WarningCollector()
    expect(wc.count()).toBe(0)
    expect(wc.all()).toEqual([])
    expect(wc.silencedCount()).toBe(0)
  })

  it('adds a warning with type, path, and issue', () => {
    const wc = new WarningCollector()
    wc.add('warn_thing', 'x', 'y')
    expect(wc.count()).toBe(1)
    expect(wc.all()).toEqual([{ type: 'warn_thing', path: 'x', issue: 'y' }])
  })

  it('attaches the optional extension field only when provided', () => {
    const wc = new WarningCollector()
    wc.add('warn_non_primary', 'a.mkv', 'Non-MP4', { extension: '.mkv' })
    expect(wc.all()[0]?.extension).toBe('.mkv')
  })

  it('omits the extension field when not provided', () => {
    const wc = new WarningCollector()
    wc.add('warn_thing', 'a', 'x')
    expect('extension' in (wc.all()[0] ?? {})).toBe(false)
  })

  it('keeps the derived scope internal — no ignore entry without a list', () => {
    // `add()` always derives a scope now, because the folder grouping keys on
    // it. That must stay invisible: a collector built with no ignore list
    // still suggests nothing, and `scope` never reaches a caller.
    const wc = new WarningCollector()
    wc.add('warn_thing', 'HD/Firefly (2002)', 'x')
    expect(wc.all()).toEqual([{ type: 'warn_thing', path: 'HD/Firefly (2002)', issue: 'x' }])
    expect('scope' in (wc.all()[0] ?? {})).toBe(false)
  })

  it('returns a defensive copy from all()', () => {
    const wc = new WarningCollector()
    wc.add('warn_thing', 'a', '1')
    const list = wc.all()
    list.push({ type: 'warn_thing', path: 'b', issue: '2' })
    expect(wc.count()).toBe(1) // unaffected by mutation of the returned array
  })

  it('sorts by (type, path) — replaces the previous insertion-order behaviour', () => {
    const wc = new WarningCollector()
    wc.add('warn_b', 'z', '1')
    wc.add('warn_a', 'y', '2')
    wc.add('warn_a', 'x', '3')
    expect(wc.all().map(w => `${w.type}/${w.path}`)).toEqual(['warn_a/x', 'warn_a/y', 'warn_b/z'])
  })

  it('silences warnings at and below a matching ignore entry', () => {
    const wc = new WarningCollector(ignoreList('shows', { shows: ['Show (2020)'] }))
    wc.add('warn_thing', 'HD/Show (2020)', 'bad')
    wc.add('warn_thing', 'HD/Show (2020)/Season 1/file.mp4', 'also bad')
    wc.add('warn_thing', 'HD/Other Show (2020)', 'visible')

    expect(wc.count()).toBe(1)
    expect(wc.all().map(w => w.path)).toEqual(['HD/Other Show (2020)'])
    expect(wc.silencedCount()).toBe(2)
  })

  it('silences regardless of warning type — there is no type scoping', () => {
    const wc = new WarningCollector(ignoreList('shows', { shows: ['Show (2020)'] }))
    wc.add('warn_episode_gaps', 'HD/Show (2020)/Season 1', 'gaps in S1')
    wc.add('warn_bad_file_name', 'HD/Show (2020)/Season 1/x.mp4', 'also silenced')

    expect(wc.count()).toBe(0)
    expect(wc.silencedCount()).toBe(2)
  })

  it('does not silence when the ignore list is empty (default)', () => {
    const wc = new WarningCollector()
    wc.add('warn_thing', 'any/path', 'x')
    expect(wc.count()).toBe(1)
    expect(wc.silencedCount()).toBe(0)
  })

  it('normalizes separators + case when matching ignored entries', () => {
    const wc = new WarningCollector(ignoreList('shows', { shows: ['Show (2020)'] }))
    wc.add('warn_thing', 'hd\\show (2020)\\season 01\\file.mp4', 'x')
    expect(wc.count()).toBe(0)
    expect(wc.silencedCount()).toBe(1)
  })

  it('reads the first segment as an item, not a category, when hasCategories is false', () => {
    // A library with `categories: []` has no category segment, so every path
    // is one level shallower.
    const l = ignoreList('shows', { shows: ['Show (2020)'] })

    const flat = new WarningCollector(l, false)
    flat.add('warn_thing', 'Show (2020)/Season 01', 'x')
    expect(flat.silencedCount()).toBe(1)

    const categorized = new WarningCollector(l, true)
    categorized.add('warn_thing', 'Show (2020)/Season 01', 'x')
    expect(categorized.silencedCount()).toBe(0)
  })

  it('uses options.scope in place of deriving levels from the path', () => {
    // The contract for checks that emit a display label rather than a library
    // path — warn_multi_quality's `Firefly (2002) — Season 1`, for instance.
    const wc = new WarningCollector(ignoreList('shows', { shows: ['Firefly (2002)'] }))
    wc.add('warn_multi_quality', 'Firefly (2002) — Season 1', 'two qualities', {
      scope: { categories: ['HD', 'SD'], levels: ['Firefly (2002)', 'Season 1'] },
    })
    expect(wc.count()).toBe(0)
    expect(wc.silencedCount()).toBe(1)
  })

  // `fix` is still accepted by `add()` so the ~100 call sites that document
  // their remedy keep compiling, but it is no longer written anywhere: the
  // remedy is identical for every row of a type, so its home is the warning
  // tables in docs/OUTPUT.md.
  it('accepts a fix option without putting it in the output', () => {
    const wc = new WarningCollector()
    wc.add('warn_q', 'HD/A (2001)', 'first', { fix: 'Do the thing.' })

    expect(JSON.stringify(wc.groupedByFolder())).not.toContain('Do the thing.')
    expect('fix' in (wc.all()[0] ?? {})).toBe(false)
  })

  describe('tallyByType', () => {
    it('returns an empty object when nothing was collected', () => {
      expect(new WarningCollector().tallyByType()).toEqual({})
    })

    it('mirrors countByType so the file and the console agree', () => {
      const wc = new WarningCollector()
      wc.add('warn_a', 'x', '1')
      wc.add('warn_b', 'y', '2')
      wc.add('warn_b', 'z', '3')

      expect(wc.tallyByType()).toEqual({ warn_b: 2, warn_a: 1 })
      // Worst first, matching countByType's order.
      expect(Object.keys(wc.tallyByType())).toEqual(['warn_b', 'warn_a'])
    })
  })

  describe('countByType', () => {
    it('returns an empty array when nothing was collected', () => {
      const wc = new WarningCollector()
      expect(wc.countByType()).toEqual([])
    })

    it('orders by count descending', () => {
      const wc = new WarningCollector()
      wc.add('warn_b', 'p1', 'i')
      wc.add('warn_b', 'p2', 'i')
      wc.add('warn_a', 'p3', 'i')
      wc.add('warn_a', 'p4', 'i')
      wc.add('warn_a', 'p5', 'i')
      wc.add('warn_c', 'p6', 'i')

      expect(wc.countByType()).toEqual([
        { type: 'warn_a', count: 3 },
        { type: 'warn_b', count: 2 },
        { type: 'warn_c', count: 1 },
      ])
    })

    it('breaks count ties alphabetically by type', () => {
      const wc = new WarningCollector()
      wc.add('warn_zeta', 'p1', 'i')
      wc.add('warn_alpha', 'p2', 'i')
      wc.add('warn_mu', 'p3', 'i')
      // All three counts are 1 → alphabetical tiebreaker
      expect(wc.countByType()).toEqual([
        { type: 'warn_alpha', count: 1 },
        { type: 'warn_mu', count: 1 },
        { type: 'warn_zeta', count: 1 },
      ])
    })
  })
})
