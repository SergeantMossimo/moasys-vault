/**
 * tools/rename-shows.ts
 * ---------------------
 * The ONE sanctioned writer in this repo.
 *
 * Everything else in MOASYS-Vault is strictly read-only against the user's
 * media library — the scanner emits warnings and the user fixes their own
 * files (see CLAUDE.md, "Hard rule"). This tool is the deliberate, narrow
 * exception: it repairs episode FILENAMES that the scanner has already
 * flagged, for libraries that are too big to fix by hand.
 *
 * It renames files. That is the entire set of filesystem mutations it can
 * perform — there is no unlink, no rmdir, no copy, no content write, and it
 * never touches a directory name. Every rename is file → file inside the
 * same directory.
 *
 * Three fix modes:
 *
 *   show-prefix     Rewrite each episode file's "<Title> (<Year>)" prefix to
 *                   match its show folder's name exactly. Fixes the class of
 *                   warn_show_year_mismatch caused by a colon in the canonical
 *                   title: the folder strips it ("Star Trek The Next
 *                   Generation (1987)") but the files spell it " - " ("Star
 *                   Trek - The Next Generation (1987) - s01e01.mp4").
 *                   Pure string surgery, no network, no TMDB.
 *
 *   episode-titles  Append " - <Episode Title>" to files that parse cleanly
 *                   but carry no title (warn_missing_episode_title). Titles
 *                   come from the TMDB caches that `npm run validate:shows`
 *                   already populated — this mode does no network I/O.
 *
 *   episode-code    Normalize the season/episode code to the configured
 *                   `episode_code_case` and the canonical multi-episode
 *                   suffix form (`s01e01-e02`, not `s01e01-02`).
 *
 * Safety model — see `validatePlan` and `apply` for the enforcement:
 *
 *   1. The drive is MANDATORY. Unlike the scan/validate runners, there is no
 *      default-to-first-root, so a forgotten argument is an error rather than
 *      a silent run against the primary server.
 *   2. Dry run by default. A full plan is built, summarized, and written to
 *      output/<drive>/shows/fixes/rename-plan.json. Nothing is renamed
 *      without --apply.
 *   3. All-or-nothing on UNSAFE entries. Collisions, illegal characters, and
 *      over-long paths abort the whole run before the first rename, so a
 *      season can never be left half-renamed.
 *   4. SKIPPED entries are not failures. Files the tool has no data for are
 *      reported and left alone; they never block the rest of the batch.
 *   5. An undo manifest is written BEFORE the first rename, and `--undo`
 *      replays it in reverse.
 *
 * Usage:
 *   npm run fix:shows -- --fix show-prefix external
 *   npm run fix:shows -- --fix show-prefix external --apply
 *   npm run fix:shows -- --fix episode-titles external --show "Barry (2018)"
 *   npm run fix:shows -- --undo output/external/shows/fixes/rename-undo-<ts>.json
 */

import fs from 'fs'
import path from 'path'

import { driveSlug, loadConfig } from '../core/config'
import { toComparableFolderName } from '../core/files'
import { canonicalEpisodeCode, compilePattern, resolveCategories } from '../core/rules/helpers'
import { loadRules } from '../core/rules/loader'
import { ShowsRules, ShowsRulesSchema, defaultShowsRules } from '../core/rules/shows'
import { reportLegacyOutputFiles, typeOutputPaths } from '../core/output-paths'
import { resolveRoot, rootNames } from '../core/runner-shared'
import { AppConfig, MediaRootConfig } from '../core/types'
import { TmdbSeasonDetails, ShowValidation } from '../validate/types'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SCRIPT_DIR = path.join(__dirname, '..', '..')

/**
 * Ceiling for a full rename target path. Windows' classic MAX_PATH is 260
 * including the drive and a NUL terminator; 240 leaves headroom for the user
 * later moving a folder one or two levels deeper without breaking the names
 * this tool wrote.
 */
const MAX_TARGET_PATH = 240

/**
 * Joiner for multi-episode files whose constituent TMDB titles are distinct
 * ("Flesh and Blood (1)" + "Flesh and Blood (2)"). Deliberately a symbol that
 * survives `stripFilenameIllegalChars` and doesn't collide with the " - "
 * that separates the structural parts of a Plex filename.
 */
const MULTI_EPISODE_JOINER = ' + '

const FIX_MODES = ['show-prefix', 'episode-titles', 'episode-code'] as const
type FixMode = (typeof FIX_MODES)[number]

// ─────────────────────────────────────────────
// Plan types
// ─────────────────────────────────────────────

/**
 * One planned rename. `dir` is relative to the drive's root_path with forward
 * slashes (matching the probe cache and warning-path convention); `from` and
 * `to` are bare filenames, because a rename never moves a file between
 * directories.
 */
export interface PlanEntry {
  dir: string
  from: string
  to: string
  /** Set when the entry warrants a human glance before --apply. */
  note?: string
}

/** A file the tool deliberately left alone, with the reason why. */
interface SkipEntry {
  path: string
  reason: string
}

export interface Plan {
  generated: string
  fix: FixMode
  drive: string
  root_path: string
  entries: PlanEntry[]
  /** No data available — reported, does not block. */
  skipped: SkipEntry[]
  /** Data available but the safe target is ambiguous — reported, does not block. */
  review: SkipEntry[]
}

/** The undo manifest: absolute paths, so replay doesn't depend on config. */
interface UndoManifest {
  generated: string
  fix: FixMode
  drive: string
  renames: Array<{ from: string; to: string }>
}

// ─────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────

interface Args {
  fix: FixMode
  drive: string
  apply: boolean
  /** Restrict the run to one show folder name, e.g. "Barry (2018)". */
  show?: string
}

function usage(): never {
  console.error(`
  MOASYS-Vault — show filename repair

  Usage:
    npm run fix:shows -- --fix <mode> <drive> [--apply] [--show "<Folder Name>"]
    npm run fix:shows -- --undo <manifest.json>

  Modes:
    show-prefix      Rewrite each file's "<Title> (<Year>)" prefix to match its show folder
    episode-titles   Append " - <Episode Title>" from the TMDB cache
    episode-code     Normalize season/episode code casing and multi-episode suffix

  The drive name is REQUIRED — it must match a "name" in config.json's shows list.
  Runs are a dry run unless you pass --apply.
`)
  process.exit(1)
}

function parseArgs(argv: string[]): Args | { undo: string } {
  const undoIndex = argv.indexOf('--undo')
  if (undoIndex !== -1) {
    const file = argv[undoIndex + 1]
    if (!file) {
      console.error('\n  Error: --undo requires a manifest path')
      usage()
    }
    return { undo: file }
  }

  const fixIndex = argv.indexOf('--fix')
  const fix = fixIndex === -1 ? undefined : argv[fixIndex + 1]
  if (fix === undefined || !FIX_MODES.includes(fix as FixMode)) {
    console.error(`\n  Error: --fix must be one of: ${FIX_MODES.join(', ')}`)
    usage()
  }

  const showIndex = argv.indexOf('--show')
  const show = showIndex === -1 ? undefined : argv[showIndex + 1]
  if (showIndex !== -1 && show === undefined) {
    console.error('\n  Error: --show requires a show folder name')
    usage()
  }

  // The drive is the first bare positional that isn't a flag or a flag's
  // value. Collecting consumed indexes first keeps this robust to flag order.
  const consumed = new Set<number>()
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--')) {
      consumed.add(index)
      if (arg === '--fix' || arg === '--show') consumed.add(index + 1)
    }
  }
  const drive = argv.find((arg, index) => !consumed.has(index) && !arg.startsWith('--'))

  if (drive === undefined) {
    console.error('\n  Error: a drive name is required (this tool never defaults to a root)')
    usage()
  }

  return { fix: fix as FixMode, drive, apply: argv.includes('--apply'), show }
}

// ─────────────────────────────────────────────
// Library walk
// ─────────────────────────────────────────────

/** One episode file located on disk, with the folder context around it. */
interface EpisodeFile {
  /** Absolute path to the containing season folder. */
  absDir: string
  /** Season folder path relative to root_path, forward slashes. */
  relDir: string
  /** Show folder name, e.g. "Star Trek The Next Generation (1987)". */
  showFolder: string
  /** Season folder name, e.g. "Season 01". */
  seasonFolder: string
  fileName: string
}

/** Normalize a path to forward slashes — matches the probe + warning convention. */
function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Walk the drive's category → show → season → file hierarchy, yielding every
 * file with a recognized video extension.
 *
 * Deliberately more permissive than `scanCategory` in media/shows.ts: it does
 * not validate folder names or emit warnings, because its job is to find files
 * to rename, not to judge the library. Folders that don't parse are simply
 * walked anyway — a bad show folder still contains episodes worth fixing.
 */
function walkEpisodeFiles(rootPath: string, rules: ShowsRules, showFilter?: string): EpisodeFile[] {
  const out: EpisodeFile[] = []
  const videoExts = new Set(rules.video_extensions.map(e => e.toLowerCase()))

  for (const category of resolveCategories(rules.categories)) {
    const categoryPath =
      category.folderName === '' ? rootPath : path.join(rootPath, category.folderName)
    if (!fs.existsSync(categoryPath)) continue

    for (const showEntry of fs.readdirSync(categoryPath, { withFileTypes: true })) {
      if (!showEntry.isDirectory()) continue
      if (showFilter !== undefined && showEntry.name !== showFilter) continue

      const showPath = path.join(categoryPath, showEntry.name)
      for (const seasonEntry of fs.readdirSync(showPath, { withFileTypes: true })) {
        if (!seasonEntry.isDirectory()) continue

        const seasonPath = path.join(showPath, seasonEntry.name)
        for (const fileEntry of fs.readdirSync(seasonPath, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue
          if (!videoExts.has(path.extname(fileEntry.name).toLowerCase())) continue

          out.push({
            absDir: seasonPath,
            relDir: toRel(path.relative(rootPath, seasonPath)),
            showFolder: showEntry.name,
            seasonFolder: seasonEntry.name,
            fileName: fileEntry.name,
          })
        }
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────
// Filename surgery
// ─────────────────────────────────────────────

/**
 * The structural parts of an episode filename, captured as RAW TEXT rather
 * than parsed numbers.
 *
 * media/shows.ts parses the same names into typed values for cataloguing; this
 * tool needs the original substrings so it can rewrite exactly one part and
 * reassemble the rest byte-for-byte. Round-tripping through parsed integers
 * would silently normalize casing and zero-padding the user didn't ask us to
 * touch.
 */
export interface StemParts {
  /** "Star Trek - The Next Generation (1987)" */
  prefix: string
  /** "s01e01" or "S03e01-e02" — exactly as it appears on disk. */
  code: string
  /** Trailing episode title, or null when the file has none. */
  title: string | null
  seasonNumber: number
  episodeStart: number
  episodeEnd: number
}

/**
 * Split a filename stem into its parts using the rules' own `patterns.file`
 * regex to decide what counts as a valid name, then recovering the raw
 * substrings by re-matching the structural separator.
 *
 * Returns null when the name doesn't match the convention at all — those files
 * are already reported by warn_bad_file_name and this tool leaves them alone.
 */
export function splitStem(stem: string, fileRegex: RegExp): StemParts | null {
  const groups = fileRegex.exec(stem)?.groups
  if (!groups) return null

  const { title, year, season, episode, episode_end, episode_title } = groups
  if (title === undefined || year === undefined || season === undefined || episode === undefined) {
    return null
  }

  const prefix = `${title.trim()} (${year})`

  // Recover the code exactly as written. Anchoring on the prefix length keeps
  // this correct for titles that themselves contain " - S..".
  const afterPrefix = stem.slice(stem.indexOf(`(${year})`) + `(${year})`.length)
  const codeMatch = /^\s-\s(S\d{2}E\d{2}(?:-E?\d{2})?)/i.exec(afterPrefix)
  if (!codeMatch?.[1]) return null

  const trimmedTitle = episode_title?.trim()
  return {
    prefix,
    code: codeMatch[1],
    title: trimmedTitle !== undefined && trimmedTitle.length > 0 ? trimmedTitle : null,
    seasonNumber: parseInt(season, 10),
    episodeStart: parseInt(episode, 10),
    episodeEnd: episode_end !== undefined ? parseInt(episode_end, 10) : parseInt(episode, 10),
  }
}

/** Reassemble a stem from its parts. Inverse of `splitStem`. */
export function joinStem(parts: Pick<StemParts, 'prefix' | 'code' | 'title'>): string {
  const base = `${parts.prefix} - ${parts.code}`
  return parts.title === null ? base : `${base} - ${parts.title}`
}

/**
 * Turn a TMDB episode title into a string safe to embed in a filename.
 *
 * Reuses `toComparableFolderName` (strip Windows-illegal characters, trim,
 * strip trailing periods and spaces) — the same normalization the music
 * tag-matching path uses — then collapses the internal whitespace runs that
 * deleting a character can leave behind.
 *
 * Illegal characters are DELETED, never substituted, including `/` and `\`:
 * `East/West` becomes `EastWest` and `ronny/lily` becomes `ronnylily`. That
 * matches how the rest of the codebase renders an unstorable name (see
 * `stripFilenameIllegalChars`), and it keeps the result matching TMDB under
 * the validator's strict tier, which deletes the same characters from the
 * other side of the comparison.
 *
 * Returns null when nothing survives.
 */
export function sanitizeEpisodeTitle(raw: string): string | null {
  const cleaned = toComparableFolderName(raw).replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : null
}

// ─────────────────────────────────────────────
// Fix mode: show-prefix
// ─────────────────────────────────────────────

/**
 * Rewrite each file's "<Title> (<Year>)" prefix to its show folder's exact
 * name. Everything after the prefix — the episode code's casing, the episode
 * title, the extension — is preserved byte-for-byte.
 *
 * Files whose prefix already equals the folder produce no entry, so a re-run
 * after a successful apply plans zero renames.
 */
export function planShowPrefix(
  files: EpisodeFile[],
  fileRegex: RegExp
): Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'> {
  const entries: PlanEntry[] = []
  const skipped: SkipEntry[] = []

  for (const file of files) {
    const ext = path.extname(file.fileName)
    const parts = splitStem(path.basename(file.fileName, ext), fileRegex)
    if (!parts) {
      skipped.push({
        path: `${file.relDir}/${file.fileName}`,
        reason: 'filename does not match the Plex naming convention',
      })
      continue
    }

    if (parts.prefix === file.showFolder) continue

    entries.push({
      dir: file.relDir,
      from: file.fileName,
      to: joinStem({ ...parts, prefix: file.showFolder }) + ext,
    })
  }

  return { entries, skipped, review: [] }
}

// ─────────────────────────────────────────────
// Fix mode: episode-titles
// ─────────────────────────────────────────────

/**
 * Map a show folder name to its TMDB id, using the validation output the
 * validate pass already wrote. Keyed on the exact folder name so the lookup
 * can't drift from what's on disk.
 */
function buildTmdbIdByShowFolder(validationPath: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!fs.existsSync(validationPath)) return out

  const parsed: unknown = JSON.parse(fs.readFileSync(validationPath, 'utf-8'))
  if (!Array.isArray(parsed)) return out

  for (const show of parsed as ShowValidation[]) {
    if (show.tmdb_id === null) continue
    out.set(`${show.title} (${show.year})`, show.tmdb_id)
  }
  return out
}

/** Load the season cache written by validate/cache.ts, keyed "<showId>:<seasonNumber>". */
function loadSeasonEpisodeNames(cachePath: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>()
  if (!fs.existsSync(cachePath)) return out

  const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) return out

  const entries = (parsed as { entries: Record<string, { value: TmdbSeasonDetails }> }).entries
  for (const [key, entry] of Object.entries(entries)) {
    const byNumber = new Map<number, string>()
    for (const episode of entry.value.episodes) byNumber.set(episode.episode_number, episode.name)
    out.set(key, byNumber)
  }
  return out
}

/** One season folder's worth of parsed files, ready for the season-level guard. */
interface SeasonGroup {
  relDir: string
  showFolder: string
  seasonNumber: number
  files: Array<{ file: EpisodeFile; parts: StemParts }>
}

/**
 * Group parseable episode files by the season folder they live in.
 *
 * `episode-titles` has to reason about a whole season at once — the guard in
 * `planEpisodeTitles` is a property of the season, not of any single file —
 * so the flat walk gets folded into season buckets first. Files that don't
 * parse are dropped here; `warn_bad_file_name` already reports them.
 */
function groupBySeason(files: EpisodeFile[], fileRegex: RegExp): SeasonGroup[] {
  const groups = new Map<string, SeasonGroup>()

  for (const file of files) {
    const ext = path.extname(file.fileName)
    const parts = splitStem(path.basename(file.fileName, ext), fileRegex)
    if (!parts) continue

    let group = groups.get(file.relDir)
    if (group === undefined) {
      group = {
        relDir: file.relDir,
        showFolder: file.showFolder,
        seasonNumber: parts.seasonNumber,
        files: [],
      }
      groups.set(file.relDir, group)
    }
    group.files.push({ file, parts })
  }

  return [...groups.values()]
}

/**
 * Append " - <Episode Title>" to files that parse cleanly but carry no title.
 *
 * Multi-episode files collect every TMDB title in [start, end] and join them.
 * The lookup tolerates gaps on purpose: TMDB sometimes folds a two-parter into
 * a single numbered episode (Abbott Elementary S3 has an episode 1 named
 * "Career Day (1) / Career Day (2)" and no episode 2 at all), so requiring one
 * title per number would wrongly skip a file we can name correctly. The rule
 * is "use whatever titles exist in the range; skip only if none do."
 *
 * ── The season guard ────────────────────────────────────────────────────────
 *
 * Titles are looked up by episode NUMBER, so the mapping is only trustworthy
 * while the local season and TMDB's agree about what episodes the season
 * contains. When they disagree, the numbering may be offset and every title in
 * the season is suspect — not just the ones that failed to resolve. So the
 * whole season is skipped unless BOTH hold:
 *
 *   1. Every parseable file resolves to at least one TMDB episode. One file
 *      pointing at a number TMDB doesn't list (a recap episode, a web short)
 *      means the season carries content TMDB doesn't know about.
 *   2. The season's files collectively resolve to exactly as many distinct
 *      TMDB episodes as TMDB lists for that season. Catches the season that is
 *      missing episodes locally.
 *
 * Counting RESOLVED TMDB episodes rather than local files is what makes this
 * correct for multi-episode files in both directions — one file covering two
 * TMDB episodes counts as two, and a file spanning a two-parter that TMDB
 * merged into one entry counts as one.
 *
 * The guard is all-or-nothing per season: a skipped season keeps every one of
 * its files untouched, including the ones that would have resolved fine.
 */
export function planEpisodeTitles(
  files: EpisodeFile[],
  fileRegex: RegExp,
  tmdbIdByShowFolder: Map<string, number>,
  seasonEpisodeNames: Map<string, Map<number, string>>
): Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'> {
  const entries: PlanEntry[] = []
  const skipped: SkipEntry[] = []
  const review: SkipEntry[] = []

  for (const group of groupBySeason(files, fileRegex)) {
    const untitled = group.files.filter(f => f.parts.title === null)
    if (untitled.length === 0) continue // nothing to add in this season

    const tmdbId = tmdbIdByShowFolder.get(group.showFolder)
    if (tmdbId === undefined) {
      skipped.push({
        path: group.relDir,
        reason: `${untitled.length} file(s) — no TMDB match in data/validation.json, run validate:shows`,
      })
      continue
    }

    const byNumber = seasonEpisodeNames.get(`${tmdbId}:${group.seasonNumber}`)
    if (byNumber === undefined) {
      skipped.push({
        path: group.relDir,
        reason: `${untitled.length} file(s) — no cached TMDB data for season ${group.seasonNumber}`,
      })
      continue
    }

    // ── Season guard ────────────────────────────────────────────────────
    const resolvedEpisodes = new Set<number>()
    let unresolvableFiles = 0
    for (const { parts } of group.files) {
      let hits = 0
      for (let n = parts.episodeStart; n <= parts.episodeEnd; n++) {
        if (byNumber.has(n)) {
          resolvedEpisodes.add(n)
          hits++
        }
      }
      if (hits === 0) unresolvableFiles++
    }

    if (unresolvableFiles > 0) {
      skipped.push({
        path: group.relDir,
        reason:
          `${untitled.length} file(s) — season not renamed: ${unresolvableFiles} file(s) reference ` +
          `an episode number TMDB doesn't list for this season, so the numbering may not line up`,
      })
      continue
    }

    if (resolvedEpisodes.size !== byNumber.size) {
      skipped.push({
        path: group.relDir,
        reason:
          `${untitled.length} file(s) — season not renamed: covers ${resolvedEpisodes.size} of ` +
          `TMDB's ${byNumber.size} episodes, so the numbering may not line up`,
      })
      continue
    }

    // ── Season agrees with TMDB — safe to name ──────────────────────────
    for (const { file, parts } of untitled) {
      const relPath = `${file.relDir}/${file.fileName}`
      const names: string[] = []
      for (let n = parts.episodeStart; n <= parts.episodeEnd; n++) {
        const name = byNumber.get(n)
        if (name !== undefined) names.push(name)
      }

      const joined = names.join(MULTI_EPISODE_JOINER)
      const title = sanitizeEpisodeTitle(joined)
      if (title === null) {
        review.push({
          path: relPath,
          reason: `TMDB title '${joined}' sanitizes to an empty string`,
        })
        continue
      }

      const isMulti = parts.episodeEnd > parts.episodeStart
      entries.push({
        dir: file.relDir,
        from: file.fileName,
        to: joinStem({ ...parts, title }) + path.extname(file.fileName),
        ...(isMulti
          ? { note: `multi-episode — TMDB gave ${names.length} title(s), review this one` }
          : {}),
      })
    }
  }

  return { entries, skipped, review }
}

// ─────────────────────────────────────────────
// Fix mode: episode-code
// ─────────────────────────────────────────────

/**
 * Rewrite the season/episode code to the configured casing and the canonical
 * multi-episode suffix (`s01e01-e02`, never the bare `s01e01-02`).
 *
 * A no-op when `episode_code_case` is 'any', since there is then no house
 * style to normalize toward.
 */
function planEpisodeCode(
  files: EpisodeFile[],
  fileRegex: RegExp,
  rules: ShowsRules
): Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'> {
  const entries: PlanEntry[] = []

  if (rules.episode_code_case === 'any') {
    console.log(
      "\n  Nothing to do: episode_code_case is 'any'. Set it to 'lower' or 'upper' in\n" +
        '  rules/shows.local.yaml to define a house style.'
    )
    return { entries, skipped: [], review: [] }
  }

  for (const file of files) {
    const ext = path.extname(file.fileName)
    const parts = splitStem(path.basename(file.fileName, ext), fileRegex)
    if (!parts) continue

    const canonical = canonicalEpisodeCode(parts, rules.episode_code_case)
    if (canonical === parts.code) continue

    entries.push({
      dir: file.relDir,
      from: file.fileName,
      to: joinStem({ ...parts, code: canonical }) + ext,
    })
  }

  return { entries, skipped: [], review: [] }
}

// ─────────────────────────────────────────────
// Plan validation
// ─────────────────────────────────────────────

/**
 * Check every planned rename for a reason it must not proceed. Returns the
 * list of problems; a non-empty list aborts the entire run before any file is
 * touched, so a batch can never be left half-applied.
 *
 * The checks:
 *   - target escapes its directory (a separator or Windows-illegal character)
 *   - two entries in this plan want the same target
 *   - the target already exists on disk, EXCEPT when it is the source file
 *     itself under a different case (that's a legitimate case-only rename,
 *     which NTFS handles fine but `fs.existsSync` reports as a collision)
 *   - the resulting absolute path exceeds MAX_TARGET_PATH
 */
export function validatePlan(plan: Plan, rootPath: string): string[] {
  const problems: string[] = []
  const claimed = new Map<string, string>()

  for (const entry of plan.entries) {
    const source = `${entry.dir}/${entry.from}`

    if (/[<>:"|?*\\/]/.test(entry.to)) {
      problems.push(`${source} → target contains an illegal character: '${entry.to}'`)
      continue
    }

    const claimKey = `${entry.dir.toLowerCase()}/${entry.to.toLowerCase()}`
    const previous = claimed.get(claimKey)
    if (previous !== undefined) {
      problems.push(`${source} → target '${entry.to}' already claimed by ${previous}`)
      continue
    }
    claimed.set(claimKey, source)

    const absTarget = path.join(rootPath, entry.dir, entry.to)
    if (absTarget.length > MAX_TARGET_PATH) {
      problems.push(`${source} → target path is ${absTarget.length} chars (max ${MAX_TARGET_PATH})`)
      continue
    }

    const isCaseOnlyRename = entry.to.toLowerCase() === entry.from.toLowerCase()
    if (!isCaseOnlyRename && fs.existsSync(absTarget)) {
      problems.push(`${source} → target already exists on disk: '${entry.to}'`)
    }
  }

  return problems
}

// ─────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────

/** Print the plan: a per-show summary, then a sample, then everything skipped. */
function report(plan: Plan): void {
  console.log(`\n  ${plan.fix} — ${plan.drive} (${plan.root_path})`)
  console.log(`  ${'─'.repeat(70)}`)

  const byShow = new Map<string, number>()
  for (const entry of plan.entries) {
    // dir is "<category>/<show>/<season>"; the show is everything but the season.
    const show = entry.dir.split('/').slice(0, -1).join('/')
    byShow.set(show, (byShow.get(show) ?? 0) + 1)
  }

  if (byShow.size > 0) {
    console.log('\n  Planned renames by show:')
    for (const show of [...byShow.keys()].sort()) {
      console.log(`    ${String(byShow.get(show)).padStart(5)}  ${show}`)
    }
  }

  const samples = plan.entries.slice(0, 5)
  if (samples.length > 0) {
    console.log('\n  Sample:')
    for (const entry of samples) {
      console.log(`    ${entry.dir}/`)
      console.log(`      -  ${entry.from}`)
      console.log(`      +  ${entry.to}`)
    }
    if (plan.entries.length > samples.length) {
      console.log(
        `    ... ${plan.entries.length - samples.length} more (see fixes/rename-plan.json)`
      )
    }
  }

  const flagged = plan.entries.filter(e => e.note !== undefined)
  if (flagged.length > 0) {
    console.log(`\n  Flagged for review (${flagged.length}) — these WILL be renamed:`)
    for (const entry of flagged) {
      console.log(`    ${entry.dir}/${entry.from}`)
      console.log(`      -> ${entry.to}`)
      console.log(`      (${entry.note})`)
    }
  }

  if (plan.review.length > 0) {
    console.log(`\n  Needs a human (${plan.review.length}) — NOT renamed:`)
    for (const item of plan.review) console.log(`    ${item.path}\n      ${item.reason}`)
  }

  if (plan.skipped.length > 0) {
    console.log(`\n  Skipped (${plan.skipped.length}) — no data, NOT renamed:`)
    for (const item of plan.skipped) console.log(`    ${item.path}\n      ${item.reason}`)
  }

  console.log(`\n  ${'─'.repeat(70)}`)
  console.log(
    `  ${plan.entries.length} to rename   ${plan.review.length} need a human   ${plan.skipped.length} skipped`
  )
}

// ─────────────────────────────────────────────
// Apply + undo
// ─────────────────────────────────────────────

/**
 * Suffix for the intermediate name in a case-only rename. Long and
 * project-specific so it can never collide with a real episode file, and
 * recognizable if a crash ever strands one on disk.
 */
const CASE_RENAME_SUFFIX = '.__moasys_case__'

/**
 * Rename one file, transparently handling the case-only rename.
 *
 * `fs.renameSync` is not enough on its own. Windows resolves a case-only
 * rename to "source and destination are the same file" and returns success
 * without changing anything — the failure is SILENT, which is the dangerous
 * kind. It bites on case-insensitive filesystems, and the user's external
 * drive is exFAT, so this is not a hypothetical: a first pass reported 726
 * successful renames while leaving all 174 case-only ones untouched.
 *
 * The fix is the standard two-step through a temporary name. If the second
 * step fails the first is rolled back, so a crash can't strand a file under
 * the temp name.
 */
export function renameFile(from: string, to: string): void {
  if (path.basename(from).toLowerCase() !== path.basename(to).toLowerCase()) {
    fs.renameSync(from, to)
    return
  }

  const staging = from + CASE_RENAME_SUFFIX
  fs.renameSync(from, staging)
  try {
    fs.renameSync(staging, to)
  } catch (err) {
    fs.renameSync(staging, from)
    throw err
  }
}

/**
 * Execute the plan. The undo manifest is written to disk BEFORE the first
 * rename so an interrupted run is still fully reversible.
 *
 * Renames run in plan order. A failure stops the run immediately rather than
 * pressing on, leaving a manifest that covers exactly what did happen.
 */
function apply(plan: Plan, rootPath: string, manifestPath: string): void {
  const manifest: UndoManifest = {
    generated: new Date().toISOString(),
    fix: plan.fix,
    drive: plan.drive,
    renames: plan.entries.map(entry => ({
      from: path.join(rootPath, entry.dir, entry.from),
      to: path.join(rootPath, entry.dir, entry.to),
    })),
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\n  [UNDO] ${manifestPath}`)

  let done = 0
  for (const rename of manifest.renames) {
    try {
      renameFile(rename.from, rename.to)
      done++
    } catch (err) {
      console.error(`\n  Rename failed after ${done} file(s): ${(err as Error).message}`)
      console.error(`    ${rename.from}`)
      console.error(`    -> ${rename.to}`)
      console.error(`\n  Reverse what was applied with:`)
      console.error(`    npm run fix:shows -- --undo ${manifestPath}`)
      process.exit(1)
    }
  }

  console.log(`  [DONE] Renamed ${done} file(s).`)
}

/**
 * Replay a manifest in reverse. Entries whose target is already gone are
 * reported and stepped over — that's the expected shape of undoing a run that
 * failed partway through.
 */
function undo(manifestPath: string): void {
  if (!fs.existsSync(manifestPath)) {
    console.error(`\n  Error: no manifest at ${manifestPath}`)
    process.exit(1)
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as UndoManifest
  console.log(
    `\n  Undoing ${manifest.fix} on ${manifest.drive} (${manifest.renames.length} rename(s))`
  )

  let reverted = 0
  let missing = 0
  for (const rename of [...manifest.renames].reverse()) {
    if (!fs.existsSync(rename.to)) {
      missing++
      continue
    }
    renameFile(rename.to, rename.from)
    reverted++
  }

  console.log(`  [DONE] Reverted ${reverted} file(s), ${missing} were not present.`)
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if ('undo' in args) {
    undo(path.resolve(args.undo))
    return
  }

  const config: AppConfig = loadConfig(SCRIPT_DIR)
  const root: MediaRootConfig | null = resolveRoot(config.shows, args.drive)
  if (root === null) {
    console.error(
      `\n  Error: no shows root named '${args.drive}'. Configured: ${rootNames(config.shows)}`
    )
    process.exit(1)
  }
  if (!fs.existsSync(root.root_path)) {
    console.error(`\n  Error: root path does not exist: ${root.root_path}`)
    process.exit(1)
  }

  const rules = loadRules({
    mediaType: 'shows',
    schema: ShowsRulesSchema,
    defaults: defaultShowsRules,
    projectRoot: SCRIPT_DIR,
  })
  const fileRegex = compilePattern(rules.patterns.file)

  const out = typeOutputPaths(SCRIPT_DIR, driveSlug(root.name), 'shows')
  reportLegacyOutputFiles(out)
  const files = walkEpisodeFiles(root.root_path, rules, args.show)

  let built: Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'>
  switch (args.fix) {
    case 'show-prefix':
      built = planShowPrefix(files, fileRegex)
      break
    case 'episode-titles':
      built = planEpisodeTitles(
        files,
        fileRegex,
        buildTmdbIdByShowFolder(out.validation),
        loadSeasonEpisodeNames(path.join(SCRIPT_DIR, 'cache', 'tmdb-show-seasons.json'))
      )
      break
    case 'episode-code':
      built = planEpisodeCode(files, fileRegex, rules)
      break
  }

  const plan: Plan = {
    generated: new Date().toISOString(),
    fix: args.fix,
    drive: root.name,
    root_path: root.root_path,
    ...built,
  }

  report(plan)

  const planPath = path.join(out.fixesDir, 'rename-plan.json')
  fs.mkdirSync(out.fixesDir, { recursive: true })
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  console.log(`  [PLAN] ${planPath}`)

  const problems = validatePlan(plan, root.root_path)
  if (problems.length > 0) {
    console.error(`\n  ABORTED — ${problems.length} unsafe rename(s). Nothing was changed.\n`)
    for (const problem of problems.slice(0, 25)) console.error(`    ${problem}`)
    if (problems.length > 25) console.error(`    ... ${problems.length - 25} more`)
    process.exit(1)
  }

  if (plan.entries.length === 0) {
    console.log('\n  Nothing to rename.\n')
    return
  }

  if (!args.apply) {
    console.log('\n  Dry run — nothing was changed. Re-run with --apply to execute.\n')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  apply(plan, root.root_path, path.join(out.fixesDir, `rename-undo-${stamp}.json`))
  console.log('')
}

// Guarded so the unit tests can import the plan-building and rename helpers
// without the CLI running (and calling process.exit) on import. The scan and
// validate runners call main() unconditionally because nothing imports them.
if (require.main === module) main()
