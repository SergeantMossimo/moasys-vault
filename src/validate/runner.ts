/**
 * validate/runner.ts
 * ------------------
 * CLI entry point for the validation pass — TMDB for movies and shows, Open
 * Library for audiobooks.
 *
 *   npm run validate:movies             # first configured movies root
 *   npm run validate:movies external    # the root named "External"
 *   npm run validate:shows
 *   npm run validate:audiobooks
 *   npm run validate:all
 *
 * Validation runs against one drive at a time, matching the scan pass — it
 * reads that drive's scan output and writes alongside it:
 *   output/<drive>/<type>/validation-warnings.json  ← low-confidence and mismatch warnings
 *   output/<drive>/<type>/data/validation.json      ← per-record TMDB resolution + alts
 *
 * The TMDB caches stay un-sharded at the top of cache/ — they're keyed by
 * title/year, not by path, so every drive benefits from the same lookups:
 *   cache/tmdb-search.json                  ← shared search-lookup cache
 *   cache/tmdb-movies.json                  ← movie-details cache
 *   cache/tmdb-shows.json                   ← show-details cache
 *   cache/openlibrary-search.json           ← Open Library search results (audiobooks)
 *
 * Movies and shows require `.secrets.json` at repo root with a TMDB API v3
 * key (see .secrets.json.example). Audiobooks need no key.
 */

import fs from 'fs'
import path from 'path'

import {
  AppConfig,
  MediaRootConfig,
  BookOutput,
  MovieOutput,
  ShowOutput,
  WarningCollector,
} from '../core/types'
import type { MovieProbeOutput } from '../probe/types'
import { driveSlug, loadConfig } from '../core/config'
import { loadRules } from '../core/rules/loader'
import { loadIgnoreList } from '../core/ignored'
import { TypeOutputPaths, reportLegacyOutputFiles, typeOutputPaths } from '../core/output-paths'
import {
  parseRunnerArgs,
  resolveRoot,
  rootNames,
  writeJsonOutput,
  writeWarnings,
} from '../core/runner-shared'

import { MoviesRulesSchema, defaultMoviesRules } from '../core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from '../core/rules/shows'
import { AudiobooksRulesSchema, defaultAudiobooksRules } from '../core/rules/audiobooks'

import { loadSecrets } from './secrets'
import { JsonCache } from './cache'
import { TmdbClient, slimSeasonDetails } from './tmdb'
import { validateMovies, movieDurationKey, type MovieDurations } from './movies'
import { validateShows } from './shows'
import { validateAudiobooks, OPENLIBRARY_CACHE_VERSION } from './audiobooks'
import { OpenLibraryClient, type OpenLibraryDoc } from './openlibrary'
import {
  ResolvedSearch,
  TmdbMovieDetails,
  TmdbShowDetails,
  TmdbSeasonDetails,
  CACHE_VERSION,
  SEARCH_CACHE_VERSION,
} from './types'

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

const SCRIPT_DIR = path.join(__dirname, '..', '..')
const CACHE_DIR = path.join(SCRIPT_DIR, 'cache')

// Needed to resolve the drive name to a configured root. Validation never
// touches root_path itself — it reads the scan output for that root — but the
// root list is what makes a name like "external" meaningful.
const CONFIG: AppConfig = loadConfig(SCRIPT_DIR)

// ─────────────────────────────────────────────
// Scan-output readers
// ─────────────────────────────────────────────

/**
 * Read one drive's scan output. Fails clearly if the file is missing —
 * validation depends on it (we don't re-scan inside the validator), and the
 * fix is to run the scan for that same drive first.
 */
function readScan<T>(p: string, mediaType: ValidateType, driveName: string): T[] {
  if (!fs.existsSync(p)) {
    console.error(`\n  Error: ${p} not found.`)
    console.error(
      `    Run \`npm run ${mediaType} ${driveName.toLowerCase()}\` first to generate it.`
    )
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T[]
}

/**
 * Build the movie→measured-runtime map that `warn_tmdb_runtime_mismatch`
 * compares against, from the same data/probe.json the scan pass wrote.
 */
function readMovieDurations(out: TypeOutputPaths, driveName: string): MovieDurations {
  const probed = readScan<MovieProbeOutput>(out.probe, 'movies', driveName)
  const map: MovieDurations = new Map()
  for (const movie of probed) {
    const files = movie.files
      .filter(f => f.duration_seconds !== null)
      .map(f => ({ path: f.path, duration_seconds: f.duration_seconds as number }))
    if (files.length > 0) {
      map.set(movieDurationKey(movie.title, movie.year, movie.edition), files)
    }
  }
  return map
}

// ─────────────────────────────────────────────
// Per-type runners
// ─────────────────────────────────────────────

async function runMovies(
  client: TmdbClient,
  refreshOlderThanDays: number,
  root: MediaRootConfig
): Promise<void> {
  const slug = driveSlug(root.name)
  const out = typeOutputPaths(SCRIPT_DIR, slug, 'movies')

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  MOASYS-Vault — Validate Movies`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('─'.repeat(50))
  console.log(`\n  Drive: ${root.name}`)
  console.log()

  const rules = loadRules({
    mediaType: 'movies',
    schema: MoviesRulesSchema,
    defaults: defaultMoviesRules,
    projectRoot: SCRIPT_DIR,
  })

  const movies = readScan<MovieOutput>(out.catalog, 'movies', root.name)
  console.log(`    [INPUT] ${movies.length} movies from ${out.displayDir}/movies.json`)

  // Measured runtimes for warn_tmdb_runtime_mismatch. Only read when the
  // check is on, so a user who disabled it isn't forced to keep probe.json.
  const wantRuntimes =
    rules.checks.warn_tmdb_runtime_mismatch && rules.runtime_tolerance_percent > 0
  const durations = wantRuntimes ? readMovieDurations(out, root.name) : undefined
  if (durations) {
    const fileCount = [...durations.values()].reduce((n, f) => n + f.length, 0)
    console.log(`    [INPUT] ${fileCount} measured runtimes from ${out.displayDir}/data/probe.json`)
  }

  const searchCache = new JsonCache<ResolvedSearch>(
    path.join(CACHE_DIR, 'tmdb-search.json'),
    SEARCH_CACHE_VERSION
  )
  const detailsCache = new JsonCache<TmdbMovieDetails>(
    path.join(CACHE_DIR, 'tmdb-movies.json'),
    CACHE_VERSION
  )
  const prunedSearch = searchCache.pruneOlderThan(refreshOlderThanDays)
  const prunedDetails = detailsCache.pruneOlderThan(refreshOlderThanDays)
  const prunedSummary =
    refreshOlderThanDays > 0
      ? ` (pruned ${prunedSearch} search + ${prunedDetails} details older than ${refreshOlderThanDays}d)`
      : ''
  console.log(
    `    [CACHE] ${searchCache.size()} search entries, ${detailsCache.size()} movie-details entries${prunedSummary}`
  )

  const warnings = new WarningCollector(
    loadIgnoreList(SCRIPT_DIR, slug, 'movies'),
    rules.categories.length > 0
  )

  const data = await validateMovies(
    movies,
    rules,
    client,
    searchCache,
    detailsCache,
    warnings,
    durations,
    (done, total, cached) => {
      if (done === total || done % 50 === 0) {
        console.log(`    [TMDB] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  console.log('\n  Writing output...')
  writeWarnings(out.validationWarnings, warnings)
  writeJsonOutput(out.validation, data)
  reportLegacyOutputFiles(out)

  searchCache.save()
  detailsCache.save()

  const silenced = warnings.silencedCount()
  const silencedSummary = silenced > 0 ? `, ${silenced} silenced via ignore list` : ''
  console.log(
    `\n  Done — ${warnings.count()} validation warnings${silencedSummary}. ${client.totalRequests} TMDB requests.`
  )
  if (warnings.count() > 0) {
    const breakdown = warnings
      .countByType()
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ')
    console.log(`    ${breakdown}`)
    console.log(`  → Review ${out.displayDir}/validation-warnings.json`)
  }
}

async function runShows(
  client: TmdbClient,
  refreshOlderThanDays: number,
  root: MediaRootConfig
): Promise<void> {
  const slug = driveSlug(root.name)
  const out = typeOutputPaths(SCRIPT_DIR, slug, 'shows')

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  MOASYS-Vault — Validate Shows`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('─'.repeat(50))
  console.log(`\n  Drive: ${root.name}`)
  console.log()

  const rules = loadRules({
    mediaType: 'shows',
    schema: ShowsRulesSchema,
    defaults: defaultShowsRules,
    projectRoot: SCRIPT_DIR,
  })

  const shows = readScan<ShowOutput>(out.catalog, 'shows', root.name)
  console.log(`    [INPUT] ${shows.length} shows from ${out.displayDir}/shows.json`)

  const searchCache = new JsonCache<ResolvedSearch>(
    path.join(CACHE_DIR, 'tmdb-search.json'),
    SEARCH_CACHE_VERSION
  )
  const detailsCache = new JsonCache<TmdbShowDetails>(
    path.join(CACHE_DIR, 'tmdb-shows.json'),
    CACHE_VERSION
  )
  const seasonsCache = new JsonCache<TmdbSeasonDetails>(
    path.join(CACHE_DIR, 'tmdb-show-seasons.json'),
    CACHE_VERSION,
    slimSeasonDetails
  )
  const prunedSearch = searchCache.pruneOlderThan(refreshOlderThanDays)
  const prunedDetails = detailsCache.pruneOlderThan(refreshOlderThanDays)
  const prunedSeasons = seasonsCache.pruneOlderThan(refreshOlderThanDays)
  const prunedSummary =
    refreshOlderThanDays > 0
      ? ` (pruned ${prunedSearch} search + ${prunedDetails} details + ${prunedSeasons} seasons older than ${refreshOlderThanDays}d)`
      : ''
  console.log(
    `    [CACHE] ${searchCache.size()} search entries, ${detailsCache.size()} show-details entries, ${seasonsCache.size()} season-details entries${prunedSummary}`
  )

  const warnings = new WarningCollector(
    loadIgnoreList(SCRIPT_DIR, slug, 'shows'),
    rules.categories.length > 0
  )

  const data = await validateShows(
    shows,
    rules,
    client,
    searchCache,
    detailsCache,
    seasonsCache,
    warnings,
    (done, total, cached) => {
      if (done === total || done % 10 === 0) {
        console.log(`    [TMDB] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  console.log('\n  Writing output...')
  writeWarnings(out.validationWarnings, warnings)
  writeJsonOutput(out.validation, data)
  reportLegacyOutputFiles(out)

  searchCache.save()
  detailsCache.save()
  seasonsCache.save()

  const silenced = warnings.silencedCount()
  const silencedSummary = silenced > 0 ? `, ${silenced} silenced via ignore list` : ''
  console.log(
    `\n  Done — ${warnings.count()} validation warnings${silencedSummary}. ${client.totalRequests} TMDB requests.`
  )
  if (warnings.count() > 0) {
    const breakdown = warnings
      .countByType()
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ')
    console.log(`    ${breakdown}`)
    console.log(`  → Review ${out.displayDir}/validation-warnings.json`)
  }
}

async function runAudiobooks(refreshOlderThanDays: number, root: MediaRootConfig): Promise<void> {
  const slug = driveSlug(root.name)
  const out = typeOutputPaths(SCRIPT_DIR, slug, 'audiobooks')

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  MOASYS-Vault — Validate Audiobooks`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('─'.repeat(50))
  console.log(`\n  Drive: ${root.name}`)
  console.log()

  const rules = loadRules({
    mediaType: 'audiobooks',
    schema: AudiobooksRulesSchema,
    defaults: defaultAudiobooksRules,
    projectRoot: SCRIPT_DIR,
  })

  const books = readScan<BookOutput>(out.catalog, 'audiobooks', root.name)
  console.log(`    [INPUT] ${books.length} books from ${out.displayDir}/audiobooks.json`)

  const searchCache = new JsonCache<OpenLibraryDoc[]>(
    path.join(CACHE_DIR, 'openlibrary-search.json'),
    OPENLIBRARY_CACHE_VERSION
  )
  const pruned = searchCache.pruneOlderThan(refreshOlderThanDays)
  const prunedSummary =
    refreshOlderThanDays > 0 ? ` (pruned ${pruned} older than ${refreshOlderThanDays}d)` : ''
  console.log(`    [CACHE] ${searchCache.size()} Open Library search entries${prunedSummary}`)

  const warnings = new WarningCollector(
    loadIgnoreList(SCRIPT_DIR, slug, 'audiobooks'),
    rules.categories.length > 0
  )

  const client = new OpenLibraryClient()
  const data = await validateAudiobooks(
    books,
    rules,
    client,
    searchCache,
    warnings,
    (done, total, cached) => {
      if (done === total || done % 10 === 0) {
        console.log(`    [OPENLIBRARY] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  console.log('\n  Writing output...')
  writeWarnings(out.validationWarnings, warnings)
  writeJsonOutput(out.validation, data)
  reportLegacyOutputFiles(out)

  searchCache.save()

  const silenced = warnings.silencedCount()
  const silencedSummary = silenced > 0 ? `, ${silenced} silenced via ignore list` : ''
  console.log(
    `\n  Done — ${warnings.count()} validation warnings${silencedSummary}. ${client.totalRequests} Open Library requests.`
  )
  if (warnings.count() > 0) {
    const breakdown = warnings
      .countByType()
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ')
    console.log(`    ${breakdown}`)
    console.log(`  → Review ${out.displayDir}/validation-warnings.json`)
  }
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  MOASYS-Vault — TMDB validation

  Usage:
    npm run validate:movies [drive]   Validate movies against TMDB
    npm run validate:shows [drive]    Validate shows against TMDB (incl. season episode counts)
    npm run validate:audiobooks [drive]  Validate audiobooks against Open Library (no key needed)
    npm run validate:all [drive]      Validate all three

  [drive] names a root from config.json. Omit it to use the first root
  configured for that type. Reads output/<drive>/<type>/<type>.json and
  writes validation-warnings.json alongside it (plus data/validation.json),
  so run the matching scan first.

  Flags:
    --refresh-older-than=Nd     Re-fetch any cache entries older than N days
                                (e.g. 30 or 30d). Without this flag, all
                                cached entries are used regardless of age.

  Examples:
    npm run validate:movies
    npm run validate:movies external

  Movies and shows require .secrets.json with a TMDB API v3 key (see
  .secrets.json.example). Audiobooks use Open Library, which needs no key.
  `)
}

/**
 * Pull `--refresh-older-than=Nd` (or `=N`) out of process.argv, returning the
 * number of days (0 = no refresh). Mutates argv so parseRunnerArgs sees a
 * clean view afterwards.
 */
function extractRefreshOlderThanFlag(): number {
  const flagPrefix = '--refresh-older-than='
  const argIndex = process.argv.findIndex(a => a.startsWith(flagPrefix))
  if (argIndex === -1) return 0

  const value = process.argv[argIndex]!.slice(flagPrefix.length)
  const match = value.match(/^(\d+)d?$/)
  if (!match) {
    console.error(
      `\n  Error: --refresh-older-than expects a number of days (e.g. 30 or 30d), got '${value}'`
    )
    process.exit(1)
  }

  process.argv.splice(argIndex, 1)
  return parseInt(match[1]!, 10)
}

// Movies and shows validate against TMDB, audiobooks against Open Library.
// Music has no validate pass — its ID3 checks run during the scan instead.
const VALIDATE_TYPES = ['movies', 'shows', 'audiobooks'] as const
type ValidateType = (typeof VALIDATE_TYPES)[number]

/**
 * Resolve the drive name against a type's configured roots. Mirrors the scan
 * runner: `--all` skips a type that has no such root, a single-type run
 * treats it as an error.
 */
function rootFor(
  mediaType: ValidateType,
  driveName: string | undefined,
  acrossAllTypes: boolean
): MediaRootConfig | null {
  const roots = CONFIG[mediaType]
  const root = resolveRoot(roots, driveName)
  if (root) return root

  const message = `no root named '${driveName}' configured for ${mediaType} (have: ${rootNames(roots)})`
  if (acrossAllTypes) {
    console.log(`\n  [SKIP] ${mediaType} — ${message}`)
    return null
  }
  console.error(`\n  Error: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  // Extract validate-only flags before parseRunnerArgs (which expects to see
  // only the standard --type/--all/--help flag set plus a bare drive name).
  const refreshOlderThanDays = extractRefreshOlderThanFlag()

  const parsed = parseRunnerArgs(VALIDATE_TYPES)

  if (parsed.kind === 'help') {
    printHelp()
    // Implicit help (no args) is conventionally an error for CLI scripts;
    // explicit `--help` is a clean exit.
    process.exit(parsed.explicit ? 0 : 1)
  }

  // Load secrets up front so a missing TMDB key fails BEFORE any work — but
  // only for runs that use TMDB. Audiobooks validate against Open Library,
  // which needs no key, so `validate:audiobooks` must work without one.
  const needsTmdb = parsed.kind === 'all' || parsed.type !== 'audiobooks'
  const tmdb = needsTmdb ? new TmdbClient(loadSecrets(SCRIPT_DIR, 'tmdb').api_key) : null

  if (parsed.kind === 'all') {
    const moviesRoot = rootFor('movies', parsed.drive, true)
    if (moviesRoot) await runMovies(tmdb!, refreshOlderThanDays, moviesRoot)
    const showsRoot = rootFor('shows', parsed.drive, true)
    if (showsRoot) await runShows(tmdb!, refreshOlderThanDays, showsRoot)
    const audiobooksRoot = rootFor('audiobooks', parsed.drive, true)
    if (audiobooksRoot) await runAudiobooks(refreshOlderThanDays, audiobooksRoot)
  } else if (parsed.type === 'movies') {
    await runMovies(tmdb!, refreshOlderThanDays, rootFor('movies', parsed.drive, false)!)
  } else if (parsed.type === 'shows') {
    await runShows(tmdb!, refreshOlderThanDays, rootFor('shows', parsed.drive, false)!)
  } else {
    await runAudiobooks(refreshOlderThanDays, rootFor('audiobooks', parsed.drive, false)!)
  }

  console.log()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
