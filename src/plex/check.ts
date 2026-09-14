/**
 * plex/check.ts
 * -------------
 * CLI entry point: `npm run plex:check [drive]`
 *
 * Compares the last `plex:pull` with the last scan of each media type on one
 * drive, and writes the findings alongside that scan's other warnings:
 *
 *   output/<drive>/<type>/plex-warnings.json
 *
 * Needs no connection to Plex — it reads output/plex/ (from `plex:pull`) and
 * output/<drive>/<type>/probe.json (from the scan), and stats files on disk
 * only to confirm that a file Plex lists is really gone.
 *
 * Per-type ignore lists (ignored/<drive>/<type>.yaml) apply to Plex warnings
 * the same way they apply to scan warnings.
 */

import fs from 'fs'
import path from 'path'

import { AppConfig, MediaRootConfig, WarningCollector } from '../core/types'
import { driveSlug, loadConfig } from '../core/config'
import { loadIgnoreList } from '../core/ignored'
import { compilePattern } from '../core/rules/helpers'
import { loadRules } from '../core/rules/loader'
import { MoviesRulesSchema, defaultMoviesRules } from '../core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from '../core/rules/shows'
import { MusicRulesSchema, defaultMusicRules } from '../core/rules/music'
import { AudiobooksRulesSchema, defaultAudiobooksRules } from '../core/rules/audiobooks'
import { PlexRulesSchema, defaultPlexRules, PlexRules } from '../core/rules/plex'
import { parseRunnerArgs, resolveRoot, rootNames, writeWarnings } from '../core/runner-shared'
import type {
  ArtistProbeOutput,
  BookProbeOutput,
  MovieProbeOutput,
  ShowProbeOutput,
} from '../probe/types'
import type { MovieValidation, ShowValidation } from '../validate/types'

import { checkPlex, tmdbMatchKey } from './checks'
import { OUTPUT_DIR, PLEX_OUTPUT_DIR, SCRIPT_DIR } from './setup'
import { MediaType, PlexCatalogOutput, PlexLibrariesOutput } from './types'

const MEDIA_TYPES: MediaType[] = ['movies', 'shows', 'music', 'audiobooks']

// ─────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
}

/** Every library-relative file path in a probe.json, whatever the media type's shape. */
function probeFilePaths(mediaType: MediaType, probePath: string): string[] {
  switch (mediaType) {
    case 'movies':
      return readJson<MovieProbeOutput[]>(probePath).flatMap(m => m.files.map(f => f.path))
    case 'shows':
      return readJson<ShowProbeOutput[]>(probePath).flatMap(s =>
        s.seasons.flatMap(season => season.episodes.map(e => e.path))
      )
    case 'music':
      return readJson<ArtistProbeOutput[]>(probePath).flatMap(a =>
        a.albums.flatMap(album => album.tracks.map(t => t.path))
      )
    case 'audiobooks':
      return readJson<BookProbeOutput[]>(probePath).flatMap(b => b.chapters.map(c => c.path))
  }
}

/**
 * Confident TMDB matches from the validate pass, keyed by folder title and
 * year, for comparing against the TMDB id Plex matched. Movies and shows
 * only; undefined when validation hasn't been run for this drive.
 * Low-confidence and unmatched entries are left out — only a match the
 * validator trusts is good evidence that Plex is wrong.
 */
function readTmdbMatches(
  mediaType: MediaType,
  slug: string
): Map<string, { id: number; title: string | null }> | undefined {
  if (mediaType !== 'movies' && mediaType !== 'shows') return undefined
  const p = path.join(OUTPUT_DIR, slug, mediaType, 'validation.json')
  if (!fs.existsSync(p)) return undefined

  const entries = readJson<Array<MovieValidation | ShowValidation>>(p)
  const matches = new Map<string, { id: number; title: string | null }>()
  for (const e of entries) {
    if (e.tmdb_id === null || (e.confidence !== 'high' && e.confidence !== 'medium')) continue
    matches.set(tmdbMatchKey(e.title, e.year), { id: e.tmdb_id, title: e.tmdb_title })
  }
  return matches
}

/**
 * What each type contributes: whether its folders are categorized (for
 * ignore-list scope) and, for movies/shows, the folder pattern that yields
 * the title and year Plex's are compared against.
 */
function typeRules(mediaType: MediaType): { hasCategories: boolean; folderPattern: RegExp | null } {
  switch (mediaType) {
    case 'movies': {
      const rules = loadRules({
        mediaType,
        schema: MoviesRulesSchema,
        defaults: defaultMoviesRules,
        projectRoot: SCRIPT_DIR,
      })
      return {
        hasCategories: rules.categories.length > 0,
        folderPattern: compilePattern(rules.patterns.folder),
      }
    }
    case 'shows': {
      const rules = loadRules({
        mediaType,
        schema: ShowsRulesSchema,
        defaults: defaultShowsRules,
        projectRoot: SCRIPT_DIR,
      })
      return {
        hasCategories: rules.categories.length > 0,
        folderPattern: compilePattern(rules.patterns.show_folder),
      }
    }
    case 'music': {
      const rules = loadRules({
        mediaType,
        schema: MusicRulesSchema,
        defaults: defaultMusicRules,
        projectRoot: SCRIPT_DIR,
      })
      return { hasCategories: rules.categories.length > 0, folderPattern: null }
    }
    case 'audiobooks': {
      const rules = loadRules({
        mediaType,
        schema: AudiobooksRulesSchema,
        defaults: defaultAudiobooksRules,
        projectRoot: SCRIPT_DIR,
      })
      return { hasCategories: rules.categories.length > 0, folderPattern: null }
    }
  }
}

// ─────────────────────────────────────────────
// Per-type run
// ─────────────────────────────────────────────

function runType(
  mediaType: MediaType,
  root: MediaRootConfig,
  libraries: PlexLibrariesOutput,
  plexRules: PlexRules
): void {
  const slug = driveSlug(root.name)
  console.log(`\n  ${mediaType} — ${root.name} (${root.root_path})`)

  const mapped = libraries.libraries.filter(l => l.media_type === mediaType)
  if (mapped.length === 0) {
    console.log(`    [SKIP] No Plex library maps to ${mediaType} — nothing to compare.`)
    return
  }

  const catalogs: PlexCatalogOutput[] = []
  for (const library of mapped) {
    const catalogPath = path.join(PLEX_OUTPUT_DIR, library.slug, 'catalog.json')
    if (!fs.existsSync(catalogPath)) {
      console.log(
        `    [SKIP] '${library.title}' hasn't been pulled — run \`npm run plex:pull "${library.title}"\`.`
      )
      continue
    }
    catalogs.push(readJson<PlexCatalogOutput>(catalogPath))
  }
  if (catalogs.length === 0) return

  const probePath = path.join(OUTPUT_DIR, slug, mediaType, 'probe.json')
  if (!fs.existsSync(probePath)) {
    console.log(`    [SKIP] ${probePath} not found — run \`npm run ${mediaType} ${slug}\` first.`)
    return
  }

  const { hasCategories, folderPattern } = typeRules(mediaType)
  const warnings = new WarningCollector(loadIgnoreList(SCRIPT_DIR, slug, mediaType), hasCategories)

  const tmdbMatches = readTmdbMatches(mediaType, slug)
  if (tmdbMatches) {
    console.log(`    [INPUT] ${tmdbMatches.size} confident TMDB matches from validation.json`)
  }

  const stats = checkPlex({
    mediaType,
    drive: root.name,
    catalogs,
    diskFiles: probeFilePaths(mediaType, probePath),
    exists: relative => fs.existsSync(path.join(root.root_path, relative)),
    folderPattern,
    tmdbMatches,
    rules: plexRules,
    warnings,
  })

  console.log(
    `    [PLEX] ${stats.plexFiles} Plex files on this drive from ${catalogs.map(c => `'${c.library.title}'`).join(', ')}; ${stats.diskFiles} files from the scan`
  )
  writeWarnings(path.join(OUTPUT_DIR, slug, mediaType, 'plex-warnings.json'), warnings)

  const silenced = warnings.silencedCount()
  if (warnings.count() > 0 || silenced > 0) {
    const breakdown = warnings
      .countByType()
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ')
    const silencedNote = silenced > 0 ? `${silenced} silenced via ignore list` : ''
    console.log(`    ${[breakdown, silencedNote].filter(Boolean).join(' — ')}`)
  }
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  MOASYS-Vault — compare Plex with your scan output

  Usage:
    npm run plex:check [drive]      Every media type on the drive
    npx tsx src/plex/check.ts --type movies [drive]

  [drive] names a root from config.json; omit it for the first root of each
  type. Reads output/plex/ (run \`npm run plex:pull\` first) and each type's
  probe.json (run the scan first). Writes output/<drive>/<type>/plex-warnings.json.
  `)
}

function main(): void {
  const parsed = parseRunnerArgs(MEDIA_TYPES)
  if (parsed.kind === 'help') {
    printHelp()
    process.exit(parsed.explicit ? 0 : 1)
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  MOASYS-Vault — Plex Check`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('─'.repeat(50))
  console.log()

  const librariesPath = path.join(PLEX_OUTPUT_DIR, 'libraries.json')
  if (!fs.existsSync(librariesPath)) {
    console.error(`\n  Error: ${librariesPath} not found. Run \`npm run plex:pull\` first.`)
    process.exit(1)
  }
  const libraries = readJson<PlexLibrariesOutput>(librariesPath)
  console.log(`    [INPUT] Plex pull from ${new Date(libraries.generated).toLocaleString()}`)

  const config: AppConfig = loadConfig(SCRIPT_DIR)
  const plexRules = loadRules({
    mediaType: 'plex',
    schema: PlexRulesSchema,
    defaults: defaultPlexRules,
    projectRoot: SCRIPT_DIR,
  })

  const types = parsed.kind === 'all' ? MEDIA_TYPES : [parsed.type as MediaType]
  for (const mediaType of types) {
    const roots = config[mediaType]
    const root = resolveRoot(roots, parsed.drive)
    if (!root) {
      const message = `no root named '${parsed.drive}' configured for ${mediaType} (have: ${rootNames(roots)})`
      if (parsed.kind === 'all') {
        console.log(`\n  [SKIP] ${mediaType} — ${message}`)
        continue
      }
      console.error(`\n  Error: ${message}`)
      process.exit(1)
    }
    runType(mediaType, root, libraries, plexRules)
  }

  console.log()
}

main()
