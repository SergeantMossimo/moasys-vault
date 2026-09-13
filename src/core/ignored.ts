/**
 * core/ignored.ts
 * ---------------
 * Loader + matcher for `ignored/<drive>/<type>.yaml` — a per-drive, per-type
 * gitignored file that lets the user persistently silence warnings.
 *
 * Scoped per drive because warning paths are relative to that drive's
 * `root_path`, so the same relative path can mean different files on
 * different drives. `ignored/server/movies.yaml` only affects runs against
 * the "Server" root.
 *
 * Lives in its own `ignored/` folder rather than `rules/` because these
 * aren't rules; they're per-library exceptions. Each type also ships a
 * committed `ignored/<type>.yaml.example` at the top level with commented
 * usage patterns — copy one into `ignored/<drive>/<type>.yaml` to start.
 *
 * Entries are BARE NAMES grouped by the level they name:
 *
 *   folders:                          # the category folder
 *     - Other HD
 *   shows:                            # a show, wherever it lives
 *     - Firefly (2002)
 *   seasons:
 *     - Comedy Central Presents (1998)/Season 3
 *   episodes:
 *     - My Name Is Earl (2005)/S03E01
 *
 * Two properties make this worth the machinery over plain path prefixes:
 *
 * 1. Names are CATEGORY-INDEPENDENT. `shows: Firefly (2002)` silences that
 *    show whether it sits in HD/, Other SD/, or both. Several checks emit a
 *    display label rather than a library path — warn_multi_quality emits
 *    `Firefly (2002) — Season 1`, with no category and no slashes — and a
 *    prefix matcher can never reach those. This one can.
 *
 * 2. One entry covers every pass. The scan pass emits the on-disk `Season 01`
 *    while the TMDB validate pass reconstructs `Season 1`; the scan pass warns
 *    about an episode's filename while the validate pass warns about its
 *    `S03E01` code. Both pairs are folded onto one key here, so the user
 *    writes one entry rather than two that look unrelated.
 *
 * There is no per-warning-type scoping: an entry silences every warning at or
 * below its level. To silence a whole warning TYPE, set
 * `checks.warn_*: false` in `rules/<type>.yaml` instead.
 */

import fs from 'fs'
import path from 'path'

import jsYaml from 'js-yaml'
import { z } from 'zod'

import { canonicalEpisodeCode, extractEpisodeCode } from './rules/helpers.js'

// ─────────────────────────────────────────────
// Levels
// ─────────────────────────────────────────────

/**
 * The YAML key for each level of each media type, outermost first. An index
 * into this array IS the level number: 0 is the category folder, 1 the item,
 * and so on down to the file.
 *
 * Key names are what the user calls the thing, not what the scanner calls it,
 * so the file reads like a sentence: `shows: Firefly (2002)`.
 */
export const LEVEL_KEYS = {
  movies: ['folders', 'movies', 'files'],
  shows: ['folders', 'shows', 'seasons', 'episodes'],
  music: ['folders', 'artists', 'albums', 'songs'],
  audiobooks: ['folders', 'authors', 'books', 'chapters'],
} as const

export type IgnoreMediaType = keyof typeof LEVEL_KEYS

/**
 * How many names an entry under each key may carry, counting the name itself
 * plus any parent qualifiers.
 *
 * The deepest level always needs a qualifier: a bare `09 - Chapter 9.mp3`
 * would match that filename in every book in the library. `seasons` needs one
 * for the same reason — a bare `Season 01` is meaningless on its own.
 * `albums` / `books` are usually distinctive enough to stand alone, so they
 * take either form.
 */
const NAME_COUNTS: Record<string, { min: number; max: number }> = {
  folders: { min: 1, max: 1 },
  movies: { min: 1, max: 1 },
  shows: { min: 1, max: 1 },
  artists: { min: 1, max: 1 },
  authors: { min: 1, max: 1 },
  albums: { min: 1, max: 2 },
  books: { min: 1, max: 2 },
  seasons: { min: 2, max: 2 },
  files: { min: 2, max: 2 },
  episodes: { min: 2, max: 3 },
  songs: { min: 2, max: 3 },
  chapters: { min: 2, max: 3 },
}

/** Human-readable qualified form per key, used in the missing-qualifier error. */
const QUALIFIER_HINTS: Record<string, string> = {
  seasons: 'Show (YEAR)/Season NN',
  files: 'Movie (YEAR)/Movie (YEAR).mkv',
  episodes: 'Show (YEAR)/S01E01  —  or  Show (YEAR)/Season 01/<filename>',
  songs: 'Album/01 - Track.flac  —  or  Artist/Album/01 - Track.flac',
  chapters: 'Book Title/01 - Chapter.mp3  —  or  Author/Book Title/01 - Chapter.mp3',
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Where a warning sits in the library hierarchy, independent of category.
 *
 * Derived from the warning's path by `deriveScope` for most checks; passed
 * explicitly via `WarningOptions.scope` by the handful that emit a display
 * label instead of a library path.
 */
export interface WarningScope {
  /**
   * Category folder(s) this warning belongs to — what a `folders:` entry
   * matches. Usually one. The duplicate-copy checks span categories by
   * definition and pass every category the item lives in, so a `folders:`
   * entry reaches those too. Empty when the library has no categories.
   */
  categories: string[]
  /**
   * Names below the category level, outermost first: for a shows season
   * warning, `['Firefly (2002)', 'Season 01']`. Index 0 is level 1. Empty
   * means the warning sits at the category root, where only a `folders:`
   * entry can reach it.
   */
  levels: string[]
}

/** One parsed entry. The last name sits at `level`; the rest qualify it. */
export interface IgnoreEntry {
  /** 0 = folders, 1 = movies/shows/artists/authors, and so on down. */
  level: number
  /**
   * Qualifier chain, outermost first; length 1 for an unqualified entry.
   * Each element is the set of canonical forms that name accepts — normally
   * one, but a shows episode accepts both its filename and its `S03E01` code
   * so an entry written either way reaches every pass.
   */
  names: string[][]
  /** The YAML key it came from. Error messages only. */
  key: string
}

/** A loaded ignore file. `mediaType` selects the per-level canonicalization. */
export interface IgnoreList {
  mediaType: IgnoreMediaType
  entries: IgnoreEntry[]
}

/** The "nothing is ignored" list, used as the WarningCollector default. */
export const EMPTY_IGNORE_LIST: IgnoreList = { mediaType: 'movies', entries: [] }

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

const NameListSchema = z.array(z.string().trim().min(1)).min(1)

/**
 * Build the schema for one media type's ignore file.
 *
 * `.strict()` so a key belonging to another type — `episodes:` in
 * `movies.yaml` — is a loud error rather than a list that silently silences
 * nothing.
 */
export function ignoreFileSchema(mediaType: IgnoreMediaType) {
  return z
    .object(Object.fromEntries(LEVEL_KEYS[mediaType].map(key => [key, NameListSchema.optional()])))
    .strict()
}

// ─────────────────────────────────────────────
// Canonicalization
// ─────────────────────────────────────────────

/**
 * Fold `Season 1` and `Season 01` onto one key.
 *
 * The scan pass emits the on-disk folder name; the TMDB validate pass builds
 * `Season ${n}` from the parsed season number. One `seasons:` entry has to
 * cover both. Named seasons ('Specials') are left alone.
 */
function canonicalSeasonName(name: string): string {
  const trimmed = name.trim()
  const m = /^season\s+0*(\d+)$/i.exec(trimmed)
  return m ? `season ${m[1]!.padStart(2, '0')}` : trimmed.toLowerCase()
}

/**
 * The canonical `S03E01` / `S03E01-E02` code for a shows deepest-level name,
 * or null when it carries none.
 *
 * Accepts both shapes that reach the matcher: a full episode filename from
 * the scan and probe passes ('My Name Is Earl (2005) - S03E01 - Pilot.mp4')
 * and the bare code the TMDB episode-name check emits. That's what lets one
 * `episodes:` entry cover all three passes.
 *
 * Reuses `extractEpisodeCode` (year-anchored, so it stays correct for shows
 * whose own title contains a ' - S..' sequence) and `canonicalEpisodeCode`
 * from core/rules/helpers, the same pair warn_episode_code_case and
 * tools/rename-shows.ts use — so the ignore list can never disagree with them
 * about what a code looks like. Routing through `canonicalEpisodeCode` also
 * folds the bare multi-episode suffix `S01E01-02` onto `S01E01-E02`.
 */
function episodeCodeOf(name: string): string | null {
  const stem = name.trim().replace(/\.[^./]+$/, '')
  const year = /\((\d{4})\)/.exec(stem)?.[1]
  const raw =
    year !== undefined
      ? extractEpisodeCode(stem, Number(year))
      : (/^(S\d{2}E\d{2}(?:-E?\d{2})?)$/i.exec(stem)?.[1] ?? null)
  if (raw === null) return null

  const m = /^S(\d{2})E(\d{2})(?:-E?(\d{2}))?$/i.exec(raw)
  if (m === null) return null
  const start = Number(m[2])
  return canonicalEpisodeCode(
    {
      seasonNumber: Number(m[1]),
      episodeStart: start,
      episodeEnd: m[3] !== undefined ? Number(m[3]) : start,
    },
    'upper'
  )
}

/**
 * Canonical form of one name at one level. Lowercased and trimmed everywhere,
 * plus the shows-specific season fold.
 */
function canonicalName(mediaType: IgnoreMediaType, level: number, name: string): string {
  if (mediaType === 'shows' && level === 2) return canonicalSeasonName(name)
  return name.trim().toLowerCase()
}

/**
 * Every canonical form a warning's name at `level` answers to. Usually one.
 * A shows episode answers to both its literal text and its episode code, so
 * the filename and the bare `S03E01` are interchangeable.
 */
function identities(mediaType: IgnoreMediaType, level: number, name: string): string[] {
  const base = canonicalName(mediaType, level, name)
  if (mediaType !== 'shows' || level !== 3) return [base]
  const code = episodeCodeOf(name)
  return code === null ? [base] : [base, code.toLowerCase()]
}

// ─────────────────────────────────────────────
// Scope derivation
// ─────────────────────────────────────────────

/**
 * Read a warning's level chain off its path.
 *
 * Correct for every check whose `path` is a real category-anchored library
 * path — 84 of them. The handful that emit a display label instead pass
 * `WarningOptions.scope` explicitly.
 *
 * `hasCategories` matters because a library with `categories: []` in its
 * rules has no category segment at all (see `resolveCategories` in
 * core/rules/helpers.ts), so every path is one level shallower. Getting it
 * backwards shifts every level by one and silences the wrong things, which is
 * why the callers derive it rather than hardcoding it.
 */
export function deriveScope(normalizedPath: string, hasCategories: boolean): WarningScope {
  const segments = normalizedPath.split('/').filter(s => s.length > 0)
  if (!hasCategories) return { categories: [], levels: segments }
  const [first, ...rest] = segments
  return { categories: first === undefined ? [] : [first], levels: rest }
}

// ─────────────────────────────────────────────
// Matcher
// ─────────────────────────────────────────────

/**
 * Return true if any entry in `list` silences this warning.
 *
 * An entry's LAST name must equal the warning's name at the entry's level.
 * The remaining names, read right-to-left, must each match some level
 * strictly above the previously-matched one, in order — so a `/` in an entry
 * means "somewhere above", not "immediately above".
 *
 * That looseness is load-bearing. `episodes: My Name Is Earl (2005)/S03E01`
 * names an episode (level 3) qualified by its show (level 1), skipping the
 * season in between. A contiguous reading would bind the show name to the
 * season level and match nothing. It generalizes for free:
 * `songs: Pink Floyd/01 - In the Flesh.flac` skips the album.
 *
 * `folders:` (level 0) sits beside the chain rather than in it — it matches
 * on the category, which is what lets it reach both a category-root warning
 * (where `levels` is empty) and a duplicate-copy check that spans categories.
 */
export function isWarningIgnored(scope: WarningScope, list: IgnoreList): boolean {
  if (list.entries.length === 0) return false

  const levels = scope.levels.map((name, i) => identities(list.mediaType, i + 1, name))
  const categories = scope.categories.map(c => c.trim().toLowerCase())

  /** True when a level's accepted forms and an entry name's overlap. */
  const hit = (levelForms: string[], entryForms: string[]): boolean =>
    entryForms.some(f => levelForms.includes(f))

  return list.entries.some(entry => {
    if (entry.level === 0) return hit(categories, entry.names[0]!)

    // An entry never reaches a warning shallower than itself: a `seasons:`
    // entry can't silence a show-level warning.
    if (levels.length < entry.level) return false

    const last = entry.names[entry.names.length - 1]!
    if (!hit(levels[entry.level - 1]!, last)) return false

    let cursor = entry.level - 1
    for (let i = entry.names.length - 2; i >= 0; i--) {
      let found = -1
      for (let l = cursor - 1; l >= 0; l--) {
        if (hit(levels[l]!, entry.names[i]!)) {
          found = l
          break
        }
      }
      if (found === -1) return false
      cursor = found
    }
    return true
  })
}

// ─────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────

/** Thrown by `parseIgnoreList`; `loadIgnoreList` prints it and exits. */
export class IgnoreListError extends Error {}

function oldFormatMessage(fileLabel: string, mediaType: IgnoreMediaType): string {
  const keys = LEVEL_KEYS[mediaType].join(', ')
  return [
    `${fileLabel} uses the old flat-list format.`,
    '',
    '  Ignore lists are now keyed by level, with bare names — no category prefix:',
    '',
    '    folders:',
    '      - Other HD',
    '    shows:',
    '      - Firefly (2002)',
    '    seasons:',
    '      - Comedy Central Presents (1998)/Season 3',
    '    episodes:',
    '      - My Name Is Earl (2005)/S03E01',
    '',
    '  A name is matched at its own level and is category-independent, so',
    '  `shows: Firefly (2002)` silences that show wherever it lives.',
    '',
    '  Warning-type scoping ({path, types: [...]}) has been removed — an entry',
    '  now silences every warning at or below its level. To silence a whole',
    `  warning type, set checks.warn_*: false in rules/${mediaType}.yaml.`,
    '',
    `  Valid keys for ${mediaType}: ${keys}`,
    '  See docs/CONFIG.md — "ignored/<drive>/<type>.yaml".',
  ].join('\n')
}

/**
 * Validate and flatten a parsed YAML document into an `IgnoreList`.
 *
 * Split out from the filesystem wrapper so tests can exercise validation
 * without writing temp files. Throws `IgnoreListError` with a ready-to-print
 * message; `loadIgnoreList` catches it and exits.
 */
export function parseIgnoreList(
  raw: unknown,
  mediaType: IgnoreMediaType,
  fileLabel: string
): IgnoreList {
  // A YAML file consisting only of comments parses to null.
  if (raw === null || raw === undefined) return { mediaType, entries: [] }

  // Checked before Zod: a top-level array against z.object().strict() yields
  // "Expected object, received array", which tells the user nothing about the
  // format change that actually broke their file.
  if (Array.isArray(raw)) throw new IgnoreListError(oldFormatMessage(fileLabel, mediaType))

  const parsed = ignoreFileSchema(mediaType).safeParse(raw)
  if (!parsed.success) {
    const lines = [
      `${fileLabel} is not a valid ${mediaType} ignore list.`,
      `  Valid keys: ${LEVEL_KEYS[mediaType].join(', ')} — each a list of names.`,
    ]
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      lines.push(`    - ${where}: ${issue.message}`)
    }
    throw new IgnoreListError(lines.join('\n'))
  }

  const entries: IgnoreEntry[] = []
  const seen = new Set<string>()
  const unqualified: { key: string; raw: string }[] = []
  const overlong: { key: string; raw: string; count: number }[] = []

  for (const [level, key] of LEVEL_KEYS[mediaType].entries()) {
    const values = (parsed.data as Record<string, string[] | undefined>)[key]
    if (values === undefined) continue

    for (const value of values) {
      const segments = value
        .split(/[/\\]/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
      if (segments.length === 0) continue

      const limits = NAME_COUNTS[key]!
      if (segments.length < limits.min) {
        unqualified.push({ key, raw: value })
        continue
      }
      if (segments.length > limits.max) {
        overlong.push({ key, raw: value, count: segments.length })
        continue
      }

      // The last segment sits at this key's level; the rest qualify it from
      // above, so they canonicalize against shallower levels.
      const offset = level - (segments.length - 1)
      const names = segments.map((s, i) => identities(mediaType, offset + i, s))

      const dedupeKey = `${level}|${names.map(forms => forms[0]!).join('/')}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      entries.push({ level, names, key })
    }
  }

  if (unqualified.length > 0) {
    const key = unqualified[0]!.key
    throw new IgnoreListError(
      [
        `${fileLabel} — '${key}' entries need a parent qualifier. These are bare:`,
        '',
        ...unqualified.map(u => `    - ${u.raw}`),
        '',
        `  A bare name here would match that ${key.replace(/s$/, '')} everywhere in the`,
        '  library. Qualify it with its parent:',
        '',
        `    ${key}:`,
        `      - ${QUALIFIER_HINTS[key] ?? 'Parent/Name'}`,
      ].join('\n')
    )
  }

  if (overlong.length > 0) {
    const { key, raw: value, count } = overlong[0]!
    throw new IgnoreListError(
      [
        `${fileLabel} — '${key}' entries take at most ${NAME_COUNTS[key]!.max} names`,
        `  (${QUALIFIER_HINTS[key] ?? 'Name'}). This has ${count}:`,
        '',
        `    - ${value}`,
      ].join('\n')
    )
  }

  return { mediaType, entries }
}

// ─────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────

/**
 * Load and validate `ignored/<driveSlug>/<mediaType>.yaml`. Returns an empty
 * list when the file doesn't exist, so a drive with nothing to silence needs
 * no file at all.
 *
 * `driveSlug` is the lowercased root name from config.json (see `driveSlug()`
 * in core/config.ts).
 *
 * On YAML parse error or validation failure: prints a clear message and
 * exits — the same fail-fast pattern as the rules loader.
 */
export function loadIgnoreList(
  projectRoot: string,
  driveSlug: string,
  mediaType: IgnoreMediaType
): IgnoreList {
  const file = path.join(projectRoot, 'ignored', driveSlug, `${mediaType}.yaml`)
  if (!fs.existsSync(file)) return { mediaType, entries: [] }

  let raw: unknown
  try {
    raw = jsYaml.load(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    console.error(`\n  Error parsing ${file}: ${(err as Error).message}`)
    process.exit(1)
  }

  try {
    return parseIgnoreList(raw, mediaType, file)
  } catch (err) {
    if (!(err instanceof IgnoreListError)) throw err
    console.error(`\n  Error: ${err.message}`)
    process.exit(1)
  }
}
