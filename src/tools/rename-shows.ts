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
 * It renames. That is the entire set of filesystem mutations it can perform —
 * there is no unlink, no rmdir, no copy, no content write. Every rename keeps
 * its parent directory: file → file inside one season folder, or (only in
 * `show-folder` mode) one named show folder → a new name inside the same
 * category folder.
 *
 * Four fix modes:
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
 *                   `--allow-partial` also names seasons that hold fewer
 *                   episodes than TMDB lists; those entries carry a note.
 *
 *   episode-code    Normalize the season/episode code to the configured
 *                   `episode_code_case` and the canonical multi-episode
 *                   suffix form (`s01e01-e02`, not `s01e01-02`), padding
 *                   unpadded numbers (`s02e4` → `s02e04`) along the way.
 *
 *   show-folder     Rename ONE show folder, named explicitly with --show and
 *                   --to, for the case where the folder rather than its files
 *                   is wrong ("Saved by Bell (1989)"). Never derives a target
 *                   on its own; the dry run prints the TMDB title and the
 *                   files' own prefix as hints. Run show-prefix afterwards to
 *                   bring the files in line with the new folder name.
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
 *      replays it in reverse — after `validateUndoManifest` confirms every
 *      entry stays inside one folder and overwrites nothing, all-or-nothing.
 *
 * Usage:
 *   npm run fix:shows -- --fix show-prefix external
 *   npm run fix:shows -- --fix show-prefix external --apply
 *   npm run fix:shows -- --fix episode-titles external --show "Barry (2018)"
 *   npm run fix:shows -- --fix episode-titles external --allow-partial
 *   npm run fix:shows -- --fix show-folder external --show "Saved by Bell (1989)" --to "Saved by the Bell (1989)"
 *   npm run fix:shows -- --undo output/external/shows/fixes/rename-undo-<ts>.json
 */

import fs from 'fs'
import path from 'path'

import { driveSlug, loadConfig, rootsFor } from '../core/config'
import { toComparableFolderName } from '../core/files'
import {
  canonicalEpisodeCode,
  compilePattern,
  resolveCategories,
  LENIENT_EPISODE_FILE,
} from '../core/rules/helpers'
import { loadTypeRules } from '../core/rules/registry'
import { ShowsRules } from '../core/rules/shows'
import { reportLegacyOutputFiles, typeOutputPaths } from '../core/output-paths'
import { PROJECT_ROOT } from '../core/project'
import { resolveRoot, rootNames } from '../core/runner-shared'
import { AppConfig, MediaRootConfig } from '../core/types'
import { TmdbSeasonDetails, ShowValidation } from '../validate/types'

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

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

const FIX_MODES = ['show-prefix', 'episode-titles', 'episode-code', 'show-folder'] as const
type FixMode = (typeof FIX_MODES)[number]

// ─────────────────────────────────────────────
// Plan types
// ─────────────────────────────────────────────

/**
 * What a rename acts on. Absent means 'file', so plans and undo manifests
 * written before `show-folder` existed still read correctly.
 */
type RenameKind = 'file' | 'folder'

/**
 * One planned rename. `dir` is relative to the drive's root_path with forward
 * slashes (matching the probe cache and warning-path convention); `from` and
 * `to` are bare names, because a rename never moves anything between
 * directories. For a folder entry `dir` is the category folder.
 */
export interface PlanEntry {
  dir: string
  from: string
  to: string
  kind?: RenameKind
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
  renames: Array<{ from: string; to: string; kind?: RenameKind }>
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
  /** show-folder only: the new folder name. */
  to?: string
  /** episode-titles only: name seasons that hold fewer episodes than TMDB lists. */
  allowPartial: boolean
}

function usage(): never {
  console.error(`
  MOASYS-Vault — show filename repair

  Usage:
    npm run fix:shows -- --fix <mode> <drive> [--apply] [--show "<Folder Name>"]
    npm run fix:shows -- --fix show-folder <drive> --show "<Old Name>" --to "<New Name>" [--apply]
    npm run fix:shows -- --undo <manifest.json>

  Modes:
    show-prefix      Rewrite each file's "<Title> (<Year>)" prefix to match its show folder
    episode-titles   Append " - <Episode Title>" from the TMDB cache
                     (--allow-partial also names seasons you hold only part of)
    episode-code    Normalize season/episode code casing, padding, and multi-episode suffix
    show-folder      Rename one show folder (--show and --to both required)

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

  const toIndex = argv.indexOf('--to')
  const to = toIndex === -1 ? undefined : argv[toIndex + 1]
  if (toIndex !== -1 && to === undefined) {
    console.error('\n  Error: --to requires a new folder name')
    usage()
  }
  if (fix === 'show-folder' && (show === undefined || to === undefined)) {
    console.error('\n  Error: show-folder requires both --show "<Old Name>" and --to "<New Name>"')
    usage()
  }
  if (fix !== 'show-folder' && to !== undefined) {
    console.error('\n  Error: --to only applies to --fix show-folder')
    usage()
  }
  const allowPartial = argv.includes('--allow-partial')
  if (fix !== 'episode-titles' && allowPartial) {
    console.error('\n  Error: --allow-partial only applies to --fix episode-titles')
    usage()
  }

  // The drive is the first bare positional that isn't a flag or a flag's
  // value. Collecting consumed indexes first keeps this robust to flag order.
  const consumed = new Set<number>()
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--')) {
      consumed.add(index)
      if (arg === '--fix' || arg === '--show' || arg === '--to') consumed.add(index + 1)
    }
  }
  const drive = argv.find((arg, index) => !consumed.has(index) && !arg.startsWith('--'))

  if (drive === undefined) {
    console.error('\n  Error: a drive name is required (this tool never defaults to a root)')
    usage()
  }

  return { fix: fix as FixMode, drive, apply: argv.includes('--apply'), show, to, allowPartial }
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
 *
 * `fallbackRegex` is tried only when `fileRegex` rejects the stem. The
 * `episode-code` mode passes `LENIENT_EPISODE_FILE` so it can parse — and
 * then pad — names like 's02e4'; every other mode leaves it out and so still
 * never touches a name the rules reject.
 */
export function splitStem(
  stem: string,
  fileRegex: RegExp,
  fallbackRegex?: RegExp
): StemParts | null {
  const groups = (fileRegex.exec(stem) ?? fallbackRegex?.exec(stem) ?? null)?.groups
  if (!groups) return null

  const { title, year, season, episode, episode_end, episode_title } = groups
  if (title === undefined || year === undefined || season === undefined || episode === undefined) {
    return null
  }

  const prefix = `${title.trim()} (${year})`

  // Recover the code exactly as written. Anchoring on the prefix length keeps
  // this correct for titles that themselves contain " - S..". Permissive about
  // digit counts and separator spacing on purpose: the regex above already
  // decided the name is acceptable, this only locates the substring.
  // `joinStem` always writes the canonical " - " back.
  const afterPrefix = stem.slice(stem.indexOf(`(${year})`) + `(${year})`.length)
  const codeMatch = /^\s?-\s?(S\d{1,3}E\d{1,3}(?:-E?\d{1,3})?)/i.exec(afterPrefix)
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
 * Rewrite each file's "<Title> (<Year>)" prefix to the title and year its show
 * folder names. Everything after the prefix — the episode code's casing, the
 * episode title, the extension — is preserved byte-for-byte.
 *
 * Files whose prefix already matches produce no entry, so a re-run after a
 * successful apply plans zero renames.
 *
 * The prefix is rebuilt from the folder's *parsed* title and year, never from
 * the folder name verbatim. Those differ whenever the folder carries a Plex
 * edition tag: episodes inside 'Spider-Noir (2026) {edition-True Hue Color}'
 * are named 'Spider-Noir (2026) - S01E01 - ...', because Plex defines an
 * edition at the show level only. Copying the folder name would push the tag
 * onto every file and break the match.
 *
 * A show folder that doesn't itself match `patterns.show_folder` is sent to
 * review, once per folder, with none of its files renamed. The folder is the
 * thing that's wrong there (warn_bad_show_folder) — copying its name into
 * every file would spread the problem, as it nearly did with
 * 'Spider-Noir (2026) [True Hue Color]'.
 */
export function planShowPrefix(
  files: EpisodeFile[],
  fileRegex: RegExp,
  showFolderRegex: RegExp
): Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'> {
  const entries: PlanEntry[] = []
  const skipped: SkipEntry[] = []
  const review: SkipEntry[] = []
  const badFolders = new Set<string>()

  for (const file of files) {
    const folderGroups = showFolderRegex.exec(file.showFolder)?.groups
    if (!folderGroups?.title || !folderGroups.year) {
      const showDir = file.relDir.split('/').slice(0, -1).join('/')
      if (!badFolders.has(showDir)) {
        badFolders.add(showDir)
        review.push({
          path: showDir,
          reason:
            'show folder does not match patterns.show_folder — fix the folder name first (warn_bad_show_folder)',
        })
      }
      continue
    }

    // The edition tag, if any, stays on the folder and off the files.
    const wantedPrefix = `${folderGroups.title.trim()} (${folderGroups.year})`

    const ext = path.extname(file.fileName)
    const parts = splitStem(path.basename(file.fileName, ext), fileRegex)
    if (!parts) {
      skipped.push({
        path: `${file.relDir}/${file.fileName}`,
        reason: 'filename does not match the Plex naming convention',
      })
      continue
    }

    if (parts.prefix === wantedPrefix) continue

    entries.push({
      dir: file.relDir,
      from: file.fileName,
      to: joinStem({ ...parts, prefix: wantedPrefix }) + ext,
    })
  }

  return { entries, skipped, review }
}

// ─────────────────────────────────────────────
// Fix mode: episode-titles
// ─────────────────────────────────────────────

/**
 * Rebuild the on-disk show folder name a validation row came from, edition tag
 * included. Two editions of one series share a title+year, so a key without
 * the tag would collapse them onto each other.
 *
 * `edition` is absent in validation.json files written before editions were
 * supported; those rows produce the plain form, exactly as they did then.
 */
function showFolderNameOf(show: ShowValidation): string {
  const base = `${show.title} (${show.year})`
  return show.edition ? `${base} {edition-${show.edition}}` : base
}

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
    out.set(showFolderNameOf(show), show.tmdb_id)
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
 * `allowPartial` (the opt-in `--allow-partial` flag) relaxes ONLY guard 2, for
 * libraries that hold part of a season. Guard 1 still applies, and every
 * entry from a partial season carries a note so the dry run shows it for
 * review — a numbering offset can't be detected without the full count.
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
  seasonEpisodeNames: Map<string, Map<number, string>>,
  allowPartial = false
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

    const partial = resolvedEpisodes.size !== byNumber.size
    if (partial && !allowPartial) {
      skipped.push({
        path: group.relDir,
        reason:
          `${untitled.length} file(s) — season not renamed: covers ${resolvedEpisodes.size} of ` +
          `TMDB's ${byNumber.size} episodes, so the numbering may not line up`,
      })
      continue
    }
    const partialNote = partial
      ? `partial season — ${resolvedEpisodes.size} of ${byNumber.size} TMDB episodes, check numbering`
      : undefined

    // ── Season agrees with TMDB (or --allow-partial) — name it ──────────
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
      const notes = [
        ...(isMulti ? [`multi-episode — TMDB gave ${names.length} title(s), review this one`] : []),
        ...(partialNote !== undefined ? [partialNote] : []),
      ]
      entries.push({
        dir: file.relDir,
        from: file.fileName,
        to: joinStem({ ...parts, title }) + path.extname(file.fileName),
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      })
    }
  }

  return { entries, skipped, review }
}

// ─────────────────────────────────────────────
// Fix mode: episode-code
// ─────────────────────────────────────────────

/**
 * Rewrite the season/episode code to the configured casing, zero-padding, and
 * the canonical multi-episode suffix (`s01e01-e02`, never the bare
 * `s01e01-02`).
 *
 * Also parses names the rules reject only because a number isn't padded
 * ('s02e4' → 's02e04') via `LENIENT_EPISODE_FILE`. A range that runs
 * backwards ('s00e110-010') can't be padded into anything meaningful, so it
 * goes to review instead.
 *
 * A no-op when `episode_code_case` is 'any', since there is then no house
 * style to normalize toward.
 */
export function planEpisodeCode(
  files: EpisodeFile[],
  fileRegex: RegExp,
  rules: Pick<ShowsRules, 'episode_code_case'>
): Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'> {
  const entries: PlanEntry[] = []
  const review: SkipEntry[] = []

  if (rules.episode_code_case === 'any') {
    console.log(
      "\n  Nothing to do: episode_code_case is 'any'. Set it to 'lower' or 'upper' in\n" +
        '  rules/shows.local.yaml to define a house style.'
    )
    return { entries, skipped: [], review }
  }

  for (const file of files) {
    const ext = path.extname(file.fileName)
    const parts = splitStem(path.basename(file.fileName, ext), fileRegex, LENIENT_EPISODE_FILE)
    if (!parts) continue

    if (parts.episodeEnd < parts.episodeStart) {
      review.push({
        path: `${file.relDir}/${file.fileName}`,
        reason: `episode range '${parts.code}' runs backwards — the intended episodes are unclear`,
      })
      continue
    }

    const canonical = canonicalEpisodeCode(parts, rules.episode_code_case)
    if (canonical === parts.code) continue

    entries.push({
      dir: file.relDir,
      from: file.fileName,
      to: joinStem({ ...parts, code: canonical }) + ext,
    })
  }

  return { entries, skipped: [], review }
}

// ─────────────────────────────────────────────
// Fix mode: show-folder
// ─────────────────────────────────────────────

/**
 * Plan renaming the show folder named exactly `from` to `to`, in every
 * category that holds it — a show split across HD and SD folders stays one
 * show. Each entry stays inside its own category folder.
 *
 * The target is always the user's explicit `--to`; this function only checks
 * it. Returns `problems` alongside the plan for the checks `validatePlan`
 * can't make because they're specific to folders: the source must exist, and
 * the target must still be a valid show folder name.
 *
 * The name comparison is exact rather than case-insensitive, because a
 * case-insensitive filesystem would otherwise let `--show "alf (1986)"` match
 * 'ALF (1986)' and plan a rename from a name that isn't on disk.
 */
export function planShowFolder(
  rootPath: string,
  rules: Pick<ShowsRules, 'categories' | 'patterns'>,
  from: string,
  to: string
): { built: Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'>; problems: string[] } {
  const entries: PlanEntry[] = []
  const problems: string[] = []

  if (from === to) {
    problems.push(`--show and --to are identical ('${from}') — nothing to rename`)
  }
  if (!compilePattern(rules.patterns.show_folder).test(to)) {
    problems.push(
      `'${to}' does not match patterns.show_folder ` +
        `(expected "Title (YEAR)", optionally "Title (YEAR) {edition-Name}")`
    )
  }
  if (/[. ]$/.test(to) || to !== to.trim()) {
    problems.push(`'${to}' has leading/trailing spaces or a trailing period Windows can't store`)
  }

  for (const category of resolveCategories(rules.categories)) {
    const categoryPath =
      category.folderName === '' ? rootPath : path.join(rootPath, category.folderName)
    if (!fs.existsSync(categoryPath)) continue

    const match = fs
      .readdirSync(categoryPath, { withFileTypes: true })
      .find(entry => entry.isDirectory() && entry.name === from)
    if (match === undefined) continue

    entries.push({ dir: toRel(category.folderName), from, to, kind: 'folder' })
  }

  if (entries.length === 0) {
    problems.push(`no show folder named exactly '${from}' in any category`)
  }

  return { built: { entries, skipped: [], review: [] }, problems }
}

/**
 * Hints for choosing a show-folder target, printed in the dry run: the
 * TMDB-canonical name (when validation matched the show) and the prefix most
 * of the folder's own files use. Advisory only — never used as the target.
 */
function showFolderHints(
  files: EpisodeFile[],
  fileRegex: RegExp,
  validationPath: string
): string[] {
  const hints: string[] = []
  const folder = files[0]?.showFolder

  if (folder !== undefined && fs.existsSync(validationPath)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(validationPath, 'utf-8'))
    const match = Array.isArray(parsed)
      ? (parsed as ShowValidation[]).find(s => showFolderNameOf(s) === folder)
      : undefined
    if (match?.tmdb_title_filename_safe != null && match.tmdb_first_air_year != null) {
      hints.push(`TMDB:        ${match.tmdb_title_filename_safe} (${match.tmdb_first_air_year})`)
    } else {
      hints.push('TMDB:        no match for the current folder name')
    }
  }

  const prefixCounts = new Map<string, number>()
  for (const file of files) {
    const parts = splitStem(path.basename(file.fileName, path.extname(file.fileName)), fileRegex)
    if (parts) prefixCounts.set(parts.prefix, (prefixCounts.get(parts.prefix) ?? 0) + 1)
  }
  const top = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (top !== undefined) {
    hints.push(`File prefix: ${top[0]} (${top[1]} of ${files.length} files)`)
  }

  return hints
}

/**
 * Longest absolute path of anything under `absDir` once `absDir` itself is
 * renamed to `newName` — the path-length check for a folder rename has to
 * look at its deepest file, not the folder.
 */
function longestPathAfterFolderRename(absDir: string, newName: string): number {
  const renamed = path.join(path.dirname(absDir), newName)
  let longest = renamed.length
  if (!fs.existsSync(absDir)) return longest

  const stack = [absDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      longest = Math.max(longest, renamed.length + child.length - absDir.length)
      if (entry.isDirectory()) stack.push(child)
    }
  }
  return longest
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
 *   - the resulting absolute path exceeds MAX_TARGET_PATH (for a folder, the
 *     path of its deepest file after the rename)
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
    const targetLength =
      entry.kind === 'folder'
        ? longestPathAfterFolderRename(path.join(rootPath, entry.dir, entry.from), entry.to)
        : absTarget.length
    if (targetLength > MAX_TARGET_PATH) {
      problems.push(`${source} → target path is ${targetLength} chars (max ${MAX_TARGET_PATH})`)
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
    // A file's dir is "<category>/<show>/<season>", so the show is everything
    // but the season. A folder entry's dir is the category and `from` the show.
    const show =
      entry.kind === 'folder'
        ? `${entry.dir}/${entry.from}`
        : entry.dir.split('/').slice(0, -1).join('/')
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
      ...(entry.kind === 'folder' ? { kind: 'folder' as const } : {}),
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
      console.error(`\n  Rename failed after ${done} item(s): ${(err as Error).message}`)
      console.error(`    ${rename.from}`)
      console.error(`    -> ${rename.to}`)
      console.error(`\n  Reverse what was applied with:`)
      console.error(`    npm run fix:shows -- --undo ${manifestPath}`)
      process.exit(1)
    }
  }

  console.log(`  [DONE] Renamed ${done} item(s).`)
}

/**
 * Check an undo manifest before replaying any of it — the same guarantees
 * `validatePlan` gives `--apply`. A manifest is a plain JSON file: one that was
 * hand-edited, truncated, or copied from another run must not be able to move
 * a file into a different folder or rename it over a file that exists, which
 * on Windows replaces (destroys) that file.
 *
 * Returns human-readable problems; empty means safe to replay. All-or-nothing:
 * the caller renames nothing if anything is wrong.
 */
export function validateUndoManifest(manifest: unknown): string[] {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !Array.isArray((manifest as UndoManifest).renames)
  ) {
    return ['not an undo manifest (no "renames" list)']
  }

  const problems: string[] = []
  const restoring = new Map<string, string>()

  for (const [i, rename] of (manifest as UndoManifest).renames.entries()) {
    const where = `renames[${i}]`
    if (typeof rename?.from !== 'string' || typeof rename?.to !== 'string') {
      problems.push(`${where}: "from" and "to" must both be file paths`)
      continue
    }
    if (!path.isAbsolute(rename.from) || !path.isAbsolute(rename.to)) {
      problems.push(`${where}: paths must be absolute — ${rename.to}`)
      continue
    }

    const from = path.resolve(rename.from)
    const to = path.resolve(rename.to)
    if (path.dirname(from).toLowerCase() !== path.dirname(to).toLowerCase()) {
      problems.push(`${where}: would move a file between folders — ${to} → ${from}`)
      continue
    }

    const key = from.toLowerCase()
    const previous = restoring.get(key)
    if (previous !== undefined) {
      problems.push(`${where}: ${from} is also restored by ${previous}`)
      continue
    }
    restoring.set(key, where)

    // Undoing restores `to` back to `from`. If something now sits at `from`
    // (and it isn't the same file under a case-only rename), the rename
    // would overwrite it.
    const caseOnly = from.toLowerCase() === to.toLowerCase()
    if (!caseOnly && fs.existsSync(from)) {
      problems.push(`${where}: ${from} already exists — undoing would overwrite it`)
      continue
    }
    // A folder may only be restored by an entry that says it's a folder, so a
    // plain file entry can never be edited into renaming a directory.
    if (rename.kind !== undefined && rename.kind !== 'file' && rename.kind !== 'folder') {
      problems.push(`${where}: unknown kind '${String(rename.kind)}'`)
      continue
    }
    if (fs.existsSync(to)) {
      const isDir = fs.statSync(to).isDirectory()
      if (rename.kind === 'folder' && !isDir) {
        problems.push(`${where}: ${to} is not a folder`)
      } else if (rename.kind !== 'folder' && !fs.statSync(to).isFile()) {
        problems.push(`${where}: ${to} is not a file`)
      }
    }
  }

  return problems
}

/**
 * Replay a manifest in reverse. Entries whose target is already gone are
 * reported and stepped over — that's the expected shape of undoing a run that
 * failed partway through. Nothing is renamed unless every entry passes
 * `validateUndoManifest`.
 */
function undo(manifestPath: string): void {
  if (!fs.existsSync(manifestPath)) {
    console.error(`\n  Error: no manifest at ${manifestPath}`)
    process.exit(1)
  }

  let manifest: UndoManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as UndoManifest
  } catch (err) {
    console.error(`\n  Error: ${manifestPath} is not valid JSON (${(err as Error).message})`)
    process.exit(1)
  }

  const problems = validateUndoManifest(manifest)
  if (problems.length > 0) {
    console.error(
      `\n  ABORTED — ${problems.length} unsafe entr${problems.length === 1 ? 'y' : 'ies'} in the manifest. Nothing was changed.\n`
    )
    for (const problem of problems.slice(0, 25)) console.error(`    ${problem}`)
    if (problems.length > 25) console.error(`    ... ${problems.length - 25} more`)
    process.exit(1)
  }

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

  console.log(`  [DONE] Reverted ${reverted} item(s), ${missing} were not present.`)
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

  const config: AppConfig = loadConfig(PROJECT_ROOT)
  // args.drive is always set here — parseArgs requires it — so resolveRoot
  // can never fall back to the first root.
  const showRoots = rootsFor(config, 'shows')
  const root: MediaRootConfig | null = resolveRoot(showRoots, args.drive)
  if (root === null) {
    console.error(
      showRoots.length === 0
        ? '\n  Error: config.json has no "shows" roots.'
        : `\n  Error: no shows root named '${args.drive}'. Configured: ${rootNames(showRoots)}`
    )
    process.exit(1)
  }
  if (!fs.existsSync(root.root_path)) {
    console.error(`\n  Error: root path does not exist: ${root.root_path}`)
    process.exit(1)
  }

  const rules = loadTypeRules('shows')
  const fileRegex = compilePattern(rules.patterns.file)

  const out = typeOutputPaths(PROJECT_ROOT, driveSlug(root.name), 'shows')
  reportLegacyOutputFiles(out)
  const files = walkEpisodeFiles(root.root_path, rules, args.show)

  let built: Omit<Plan, 'generated' | 'fix' | 'drive' | 'root_path'>
  let modeProblems: string[] = []
  switch (args.fix) {
    case 'show-folder': {
      // parseArgs guarantees both --show and --to for this mode.
      const planned = planShowFolder(root.root_path, rules, args.show!, args.to!)
      built = planned.built
      modeProblems = planned.problems
      const hints = showFolderHints(files, fileRegex, out.validation)
      if (hints.length > 0) {
        console.log(`\n  Hints for '${args.show}' (check --to against these):`)
        for (const hint of hints) console.log(`    ${hint}`)
      }
      break
    }
    case 'show-prefix':
      built = planShowPrefix(files, fileRegex, compilePattern(rules.patterns.show_folder))
      break
    case 'episode-titles':
      built = planEpisodeTitles(
        files,
        fileRegex,
        buildTmdbIdByShowFolder(out.validation),
        loadSeasonEpisodeNames(path.join(PROJECT_ROOT, 'cache', 'tmdb-show-seasons.json')),
        args.allowPartial
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

  const problems = [...modeProblems, ...validatePlan(plan, root.root_path)]
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
