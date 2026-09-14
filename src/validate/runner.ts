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
 *   cache/tmdb-show-seasons.json            ← per-season episode titles
 *   cache/openlibrary-search.json           ← Open Library search results (audiobooks)
 *
 * Movies and shows require `.secrets.json` at repo root with a TMDB API v3
 * key (see .secrets.json.example). Audiobooks need no key. Under
 * `validate:all`, a missing key skips movies and shows rather than failing.
 */

import fs from 'fs'
import path from 'path'

import {
  AppConfig,
  BookOutput,
  MediaRootConfig,
  MovieOutput,
  ShowOutput,
  WarningCollector,
} from '../core/types'
import type { MovieProbeOutput } from '../probe/types'
import { driveSlug, loadConfig } from '../core/config'
import { loadTypeRules } from '../core/rules/registry'
import { loadIgnoreList } from '../core/ignored'
import { TypeOutputPaths, reportLegacyOutputFiles, typeOutputPaths } from '../core/output-paths'
import { PROJECT_ROOT } from '../core/project'
import {
  parseRunnerArgs,
  printBanner,
  printRunSummary,
  selectRoot,
  writeJsonOutput,
  writeWarnings,
} from '../core/runner-shared'

import { hasSecrets, loadSecrets } from './secrets'
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

const CACHE_DIR = path.join(PROJECT_ROOT, 'cache')

// Movies and shows validate against TMDB, audiobooks against Open Library.
// Music has no validate pass — its ID3 checks run during the scan instead.
const VALIDATE_TYPES = ['movies', 'shows', 'audiobooks'] as const
type ValidateType = (typeof VALIDATE_TYPES)[number]

// ─────────────────────────────────────────────
// Shared per-run setup
// ─────────────────────────────────────────────

/** Everything a per-type validator needs that doesn't depend on the type. */
interface RunContext {
  root: MediaRootConfig
  out: TypeOutputPaths
  warnings: WarningCollector
  refreshOlderThanDays: number
}

function startRun(
  mediaType: ValidateType,
  label: string,
  root: MediaRootConfig,
  hasCategories: boolean,
  refreshOlderThanDays: number
): RunContext {
  const slug = driveSlug(root.name)
  printBanner(`Validate ${label}`, root)
  return {
    root,
    out: typeOutputPaths(PROJECT_ROOT, slug, mediaType),
    warnings: new WarningCollector(loadIgnoreList(PROJECT_ROOT, slug, mediaType), hasCategories),
    refreshOlderThanDays,
  }
}

/** Write both output files and print the closing summary. */
function finishRun(ctx: RunContext, data: unknown, requestSummary: string): void {
  console.log('\n  Writing output...')
  writeWarnings(ctx.out.validationWarnings, ctx.warnings)
  writeJsonOutput(ctx.out.validation, data)
  reportLegacyOutputFiles(ctx.out)
  printRunSummary(ctx.warnings, {
    noun: 'validation warnings',
    tail: ` ${requestSummary}`,
    review: `${ctx.out.displayDir}/validation-warnings.json`,
  })
}

/** Open a cache and drop entries older than `--refresh-older-than`. */
function openCache<T>(
  file: string,
  version: number,
  days: number,
  normalize?: (value: T) => T
): { cache: JsonCache<T>; pruned: number } {
  const cache = new JsonCache<T>(path.join(CACHE_DIR, file), version, normalize)
  return { cache, pruned: cache.pruneOlderThan(days) }
}

function prunedNote(days: number, pruned: string): string {
  return days > 0 ? ` (pruned ${pruned} older than ${days}d)` : ''
}

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

async function runMovies(client: TmdbClient, root: MediaRootConfig, days: number): Promise<void> {
  const rules = loadTypeRules('movies')
  const ctx = startRun('movies', 'Movies', root, rules.categories.length > 0, days)

  const movies = readScan<MovieOutput>(ctx.out.catalog, 'movies', root.name)
  console.log(`    [INPUT] ${movies.length} movies from ${ctx.out.displayDir}/movies.json`)

  // Measured runtimes for warn_tmdb_runtime_mismatch. Only read when the
  // check is on, so a user who disabled it isn't forced to keep probe.json.
  const wantRuntimes =
    rules.checks.warn_tmdb_runtime_mismatch && rules.runtime_tolerance_percent > 0
  const durations = wantRuntimes ? readMovieDurations(ctx.out, root.name) : undefined
  if (durations) {
    const fileCount = [...durations.values()].reduce((n, f) => n + f.length, 0)
    console.log(
      `    [INPUT] ${fileCount} measured runtimes from ${ctx.out.displayDir}/data/probe.json`
    )
  }

  const search = openCache<ResolvedSearch>('tmdb-search.json', SEARCH_CACHE_VERSION, days)
  const details = openCache<TmdbMovieDetails>('tmdb-movies.json', CACHE_VERSION, days)
  console.log(
    `    [CACHE] ${search.cache.size()} search entries, ${details.cache.size()} movie-details entries` +
      prunedNote(days, `${search.pruned} search + ${details.pruned} details`)
  )

  const data = await validateMovies(
    movies,
    rules,
    client,
    search.cache,
    details.cache,
    ctx.warnings,
    durations,
    (done, total, cached) => {
      if (done === total || done % 50 === 0) {
        console.log(`    [TMDB] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  search.cache.save()
  details.cache.save()
  finishRun(ctx, data, `${client.totalRequests} TMDB requests.`)
}

async function runShows(client: TmdbClient, root: MediaRootConfig, days: number): Promise<void> {
  const rules = loadTypeRules('shows')
  const ctx = startRun('shows', 'Shows', root, rules.categories.length > 0, days)

  const shows = readScan<ShowOutput>(ctx.out.catalog, 'shows', root.name)
  console.log(`    [INPUT] ${shows.length} shows from ${ctx.out.displayDir}/shows.json`)

  const search = openCache<ResolvedSearch>('tmdb-search.json', SEARCH_CACHE_VERSION, days)
  const details = openCache<TmdbShowDetails>('tmdb-shows.json', CACHE_VERSION, days)
  const seasons = openCache<TmdbSeasonDetails>(
    'tmdb-show-seasons.json',
    CACHE_VERSION,
    days,
    slimSeasonDetails
  )
  console.log(
    `    [CACHE] ${search.cache.size()} search entries, ${details.cache.size()} show-details entries, ${seasons.cache.size()} season-details entries` +
      prunedNote(
        days,
        `${search.pruned} search + ${details.pruned} details + ${seasons.pruned} seasons`
      )
  )

  const data = await validateShows(
    shows,
    rules,
    client,
    search.cache,
    details.cache,
    seasons.cache,
    ctx.warnings,
    (done, total, cached) => {
      if (done === total || done % 10 === 0) {
        console.log(`    [TMDB] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  search.cache.save()
  details.cache.save()
  seasons.cache.save()
  finishRun(ctx, data, `${client.totalRequests} TMDB requests.`)
}

async function runAudiobooks(root: MediaRootConfig, days: number): Promise<void> {
  const rules = loadTypeRules('audiobooks')
  const ctx = startRun('audiobooks', 'Audiobooks', root, rules.categories.length > 0, days)

  const books = readScan<BookOutput>(ctx.out.catalog, 'audiobooks', root.name)
  console.log(`    [INPUT] ${books.length} books from ${ctx.out.displayDir}/audiobooks.json`)

  const search = openCache<OpenLibraryDoc[]>(
    'openlibrary-search.json',
    OPENLIBRARY_CACHE_VERSION,
    days
  )
  console.log(
    `    [CACHE] ${search.cache.size()} Open Library search entries` +
      prunedNote(days, String(search.pruned))
  )

  const client = new OpenLibraryClient()
  const data = await validateAudiobooks(
    books,
    rules,
    client,
    search.cache,
    ctx.warnings,
    (done, total, cached) => {
      if (done === total || done % 10 === 0) {
        console.log(`    [OPENLIBRARY] ${done}/${total} (${cached} cached)`)
      }
    }
  )

  search.cache.save()
  finishRun(ctx, data, `${client.totalRequests} Open Library requests.`)
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  MOASYS-Vault — TMDB validation

  Usage:
    npm run validate:movies [drive]      Validate movies against TMDB
    npm run validate:shows [drive]       Validate shows against TMDB (incl. season episode counts)
    npm run validate:audiobooks [drive]  Validate audiobooks against Open Library (no key needed)
    npm run validate:all [drive]         Validate all three

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
  .secrets.json.example); validate:all skips them when there's no key.
  Audiobooks use Open Library, which needs no key.
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

async function main(): Promise<void> {
  // Extract validate-only flags before parseRunnerArgs (which expects to see
  // only the standard --type/--all/--help flag set plus a bare drive name).
  const days = extractRefreshOlderThanFlag()

  const parsed = parseRunnerArgs(VALIDATE_TYPES)

  if (parsed.kind === 'help') {
    printHelp()
    // Implicit help (no args) is conventionally an error for CLI scripts;
    // explicit `--help` is a clean exit.
    process.exit(parsed.explicit ? 0 : 1)
  }

  // Needed to resolve the drive name to a configured root. Validation never
  // touches root_path itself — it reads the scan output for that root.
  const config: AppConfig = loadConfig(PROJECT_ROOT)
  const acrossAllTypes = parsed.kind === 'all'
  const types: readonly ValidateType[] = acrossAllTypes
    ? VALIDATE_TYPES
    : [parsed.type as ValidateType]

  // A missing TMDB key fails a single movies/shows run up front, before any
  // work. Under validate:all it skips the TMDB types instead, so audiobooks
  // (Open Library, no key) still run.
  const wantsTmdb = types.some(t => t !== 'audiobooks')
  const tmdbAvailable = !acrossAllTypes || hasSecrets(PROJECT_ROOT, 'tmdb')
  const tmdb =
    wantsTmdb && tmdbAvailable ? new TmdbClient(loadSecrets(PROJECT_ROOT, 'tmdb').api_key) : null

  for (const mediaType of types) {
    if (mediaType !== 'audiobooks' && tmdb === null) {
      console.log(`\n  [SKIP] ${mediaType} — no TMDB key in .secrets.json`)
      continue
    }
    const root = selectRoot(config, mediaType, parsed.drive, acrossAllTypes)
    if (!root) continue

    if (mediaType === 'movies') await runMovies(tmdb!, root, days)
    else if (mediaType === 'shows') await runShows(tmdb!, root, days)
    else await runAudiobooks(root, days)
  }

  console.log()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
