/**
 * plex/logs.ts
 * ------------
 * CLI entry point: `npm run plex:logs [drive]`
 *
 * Downloads the server's logs, finds the errors and warnings Plex logged
 * about files in your libraries, and writes them beside each type's other
 * warnings:
 *
 *   output/<drive>/<type>/plex-log-warnings.json  ← problems tied to a file or folder
 *   output/plex/logs-summary.json                 ← every distinct problem, with counts
 *   cache/plex-logs/latest.zip                    ← the archive as downloaded
 *
 * Logs come from `GET /diagnostics/logs` — the same zip as "Download Logs" in
 * Plex Web — so Plex's app-data folder never has to be shared over the
 * network. That endpoint needs the server owner's token.
 *
 * Items are identified through the catalogs from `plex:pull`, so run a pull
 * first; a pull older than the logs leaves new items unidentified.
 *
 * Read-only: one GET for the archive, nothing else sent to the server.
 */

import fs from 'fs'
import path from 'path'

import { writeFileAtomic } from '../core/atomic-write'
import { PROJECT_ROOT } from '../core/project'
import { parseRunnerArgs, printBanner, selectRoot, writeJsonOutput } from '../core/runner-shared'
import { loadTypeRules } from '../core/rules/registry'

import { LogItemIndex, PlexLogSummaryOutput, checkPlexLogs, summarizeLogs } from './log-checks'
import { extractEvents, libraryPathFinder, readLogArchive } from './log-parser'
import {
  MEDIA_TYPES,
  NO_IGNORE_FLAG,
  noIgnoreRequested,
  plexWarningCollector,
  warningsPath,
  writePlexWarnings,
} from './run-shared'
import { PLEX_OUTPUT_DIR, openPlexSession } from './setup'
import { MediaType, PlexCatalogOutput, PlexLibrariesOutput } from './types'

const ARCHIVE_PATH = path.join(PROJECT_ROOT, 'cache', 'plex-logs', 'latest.zip')

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T
}

/** Every pulled catalog for a library that maps to a media type. */
function readPulledCatalogs(libraries: PlexLibrariesOutput): PlexCatalogOutput[] {
  const catalogs: PlexCatalogOutput[] = []
  for (const library of libraries.libraries) {
    if (library.media_type === null) continue
    const catalogPath = path.join(PLEX_OUTPUT_DIR, library.slug, 'catalog.json')
    if (!fs.existsSync(catalogPath)) {
      console.log(
        `    [SKIP] '${library.title}' hasn't been pulled — its items can't be identified in the logs.`
      )
      continue
    }
    catalogs.push(readJson<PlexCatalogOutput>(catalogPath))
  }
  return catalogs
}

function printHelp(): void {
  console.log(`
  MOASYS-Vault — problems from Plex's logs

  Usage:
    npm run plex:logs [drive]          Every media type on the drive
    npm run plex:logs -- ${NO_IGNORE_FLAG}   Skip the ignore lists, to review what they hide
    npx tsx src/plex/logs.ts --type shows [drive]

  Downloads the server's logs (needs the server owner's token) and matches
  problems to items from the last \`npm run plex:pull\`. Writes
  output/<drive>/<type>/plex-log-warnings.json and output/plex/logs-summary.json.
  `)
}

async function main(): Promise<void> {
  const parsed = parseRunnerArgs(MEDIA_TYPES)
  if (parsed.kind === 'help') {
    printHelp()
    process.exit(parsed.explicit ? 0 : 1)
  }

  printBanner('Plex Logs')

  const librariesPath = path.join(PLEX_OUTPUT_DIR, 'libraries.json')
  if (!fs.existsSync(librariesPath)) {
    console.error(`\n  Error: ${librariesPath} not found. Run \`npm run plex:pull\` first.`)
    process.exit(1)
  }
  const libraries = readJson<PlexLibrariesOutput>(librariesPath)
  console.log(`    [INPUT] Plex pull from ${new Date(libraries.generated).toLocaleString()}`)
  const unfiltered = noIgnoreRequested()
  if (unfiltered) {
    console.log(`    [INPUT] ${NO_IGNORE_FLAG}: ignore lists skipped — writing to unfiltered/`)
  }

  const { config, client } = await openPlexSession()

  let archive: Uint8Array
  try {
    archive = await client.serverLogs()
  } catch (err) {
    console.error(`\n  Error downloading logs: ${(err as Error).message}`)
    process.exit(1)
  }
  writeFileAtomic(ARCHIVE_PATH, archive)
  console.log(
    `    [PLEX] Downloaded logs (${(archive.length / 1_048_576).toFixed(1)} MB) → ${path.relative(PROJECT_ROOT, ARCHIVE_PATH)}`
  )

  const logFiles = readLogArchive(archive).map(f => ({ ...f, text: client.redact(f.text) }))
  const index = new LogItemIndex(readPulledCatalogs(libraries))
  const findPath = libraryPathFinder(index.locationPrefixes)
  const events = logFiles.flatMap(f => extractEvents(f, findPath)).map(e => index.resolve(e))
  const tied = events.filter(e => e.targets.length > 0).length
  console.log(
    `    [LOGS] ${logFiles.length} server/scanner logs — ${events.length} error/warning lines, ${tied} tied to library items`
  )
  const unknown = events.filter(e => e.unknownItem).length
  if (unknown > 0) {
    console.log(
      `    [LOGS] ${unknown} line(s) name items the last pull doesn't have — run \`npm run plex:pull\` and re-run to identify them.`
    )
  }

  const summary: PlexLogSummaryOutput = {
    generated: new Date().toISOString(),
    ...summarizeLogs(
      events,
      logFiles.map(f => f.name)
    ),
  }
  writeJsonOutput(path.join(PLEX_OUTPUT_DIR, 'logs-summary.json'), summary)

  const plexRules = loadTypeRules('plex')

  const acrossAllTypes = parsed.kind === 'all'
  const types = acrossAllTypes ? MEDIA_TYPES : [parsed.type as MediaType]
  for (const mediaType of types) {
    const root = selectRoot(config, mediaType, parsed.drive, acrossAllTypes)
    if (!root) continue

    console.log(`\n  ${mediaType} — ${root.name} (${root.root_path})`)
    const warnings = plexWarningCollector(root, mediaType, unfiltered)
    const landed = checkPlexLogs({
      mediaType,
      drive: root.name,
      events,
      rules: plexRules,
      warnings,
    })
    console.log(`    [LOGS] ${landed} line(s) about this drive's ${mediaType}`)
    writePlexWarnings(warningsPath(root, mediaType, 'plexLogWarnings', unfiltered), warnings)
  }

  console.log()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
