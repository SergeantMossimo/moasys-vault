/**
 * report.ts
 * ---------
 * CLI entry point for the merged warnings report.
 *
 *   npm run report                 # every type, first configured root each
 *   npm run report external        # ...for the root named "External"
 *   npm run report -- --type shows external
 *
 * Reads the four per-command warnings files for one drive and media type and
 * folds them into one entry per top-level folder:
 *
 *   output/<drive>/<type>/all-warnings.json
 *
 * Why it exists: each command writes its own file at its own time, so a show
 * with a naming problem and a missing-episode problem is listed in two places
 * and has to be joined by hand. On one real drive 56 of 155 shows appeared in
 * both warnings.json and validation-warnings.json.
 *
 * Unlike every other runner this one deliberately does NOT call
 * `rootPathAvailable()`: it reads only files under `output/` and never touches
 * a media root, so the report stays reviewable with the drive unplugged. It
 * still resolves the drive *name* through `selectRoot`, because that is what
 * names the output folder.
 *
 * It reads the ignore-filtered files only. `--no-ignore` copies under
 * `unfiltered/` are a one-off review, not something to merge.
 */

import fs from 'fs'
import path from 'path'

import { AppConfig, MediaRootConfig, MergedWarningsOutput } from './core/types'
import { driveSlug, loadConfig } from './core/config'
import { reportLegacyOutputFiles, typeOutputPaths } from './core/output-paths'
import { MEDIA_TYPES, MediaType, PROJECT_ROOT } from './core/project'
import { parseRunnerArgs, printBanner, selectRoot, writeJsonOutput } from './core/runner-shared'
import { isWarningsOutput, mergeWarnings } from './core/warnings-merge'
import type { MergeInput } from './core/warnings-merge'

// ─────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────

/**
 * Music has no validate pass — its ID3 checks run during the scan — so there
 * is no `npm run validate:music` to point anyone at. Listing the source as
 * `missing` would name a script that doesn't exist, so it is left out for
 * music entirely.
 */
const VALIDATES: readonly MediaType[] = ['movies', 'shows', 'audiobooks']

/**
 * The files the report folds together, in pipeline order — which is also the
 * order `commands` and same-location rows are listed in.
 *
 * `rerun` is spelled out per source because the npm script names don't follow
 * one pattern: the scan is `npm run shows`, validation is
 * `npm run validate:shows`, and the Plex commands take no type at all.
 */
function sourcesFor(mediaType: MediaType, root: MediaRootConfig): MergeInput[] {
  const out = typeOutputPaths(PROJECT_ROOT, driveSlug(root.name), mediaType)
  const drive = root.name.toLowerCase()
  const specs: Array<{ command: string; file: string; rerun: string }> = [
    { command: 'scan', file: out.warnings, rerun: `npm run ${mediaType} ${drive}` },
    ...(VALIDATES.includes(mediaType)
      ? [
          {
            command: 'validate',
            file: out.validationWarnings,
            rerun: `npm run validate:${mediaType} ${drive}`,
          },
        ]
      : []),
    { command: 'plex:check', file: out.plexWarnings, rerun: `npm run plex:check ${drive}` },
    { command: 'plex:logs', file: out.plexLogWarnings, rerun: `npm run plex:logs ${drive}` },
  ]
  return specs.map(spec => ({ ...spec, file: path.basename(spec.file), ...read(spec.file) }))
}

/**
 * Read one source. A file that parses but isn't the current shape — one left
 * by a version before the folder regrouping — is reported as `unreadable` with
 * a re-run hint rather than silently contributing nothing.
 */
function read(file: string): Pick<MergeInput, 'data' | 'problem' | 'detail'> {
  if (!fs.existsSync(file)) return { data: null, problem: 'missing' }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!isWarningsOutput(parsed)) {
      return { data: null, problem: 'unreadable', detail: 'written by an older version' }
    }
    return { data: parsed }
  } catch (err) {
    return {
      data: null,
      problem: 'unreadable',
      detail: err instanceof Error ? err.message : 'could not be parsed',
    }
  }
}

// ─────────────────────────────────────────────
// Per-type run
// ─────────────────────────────────────────────

function runType(mediaType: MediaType, root: MediaRootConfig): void {
  const out = typeOutputPaths(PROJECT_ROOT, driveSlug(root.name), mediaType)
  const inputs = sourcesFor(mediaType, root)

  console.log(`\n  ${mediaType}`)
  for (const source of inputs) {
    const label =
      source.data === null ? (source.problem ?? 'missing').toUpperCase() : `${source.data.count}`
    console.log(`    [${source.command}] ${source.file} — ${label}`)
  }

  const merged: MergedWarningsOutput = mergeWarnings(inputs, {
    mediaType,
    drive: driveSlug(root.name),
  })

  writeJsonOutput(out.allWarnings, merged)
  reportLegacyOutputFiles(out)

  const unread = merged.sources.filter(s => s.count === null)
  if (unread.length === merged.sources.length) {
    // Still written, so the file explains itself rather than being absent — but
    // it must not be mistaken for a clean library.
    console.log(`    [NOTE] No warnings file could be read for ${mediaType}. Nothing was merged.`)
    console.log(`           Run the commands listed in "sources" in the file, then report again.`)
  } else if (unread.length > 0) {
    console.log(
      `    [NOTE] ${unread.length} of ${merged.sources.length} commands contributed nothing: ` +
        `${unread.map(s => s.command).join(', ')}. See "sources" in the file.`
    )
  }

  const stale = merged.sources.filter(s => s.status === 'stale')
  if (stale.length > 0) {
    console.log(
      `    [NOTE] Older than the scan: ${stale.map(s => s.command).join(', ')}. Folded in anyway.`
    )
  }

  console.log(`    ${merged.count} warnings across ${merged.folder_count} folders`)
  if (merged.count > 0) console.log(`  → Review ${out.displayDir}/all-warnings.json`)
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  MOASYS-Vault — merged warnings report

  Usage:
    npm run report [drive]                One entry per folder, every media type
    npm run report -- --type shows [drive]  ...for one type only

  [drive] names a root from config.json. Omit it to use the first root
  configured for each type.

  Folds these into output/<drive>/<type>/all-warnings.json:
    warnings.json             (npm run <type>)
    validation-warnings.json  (npm run validate:<type>)
    plex-warnings.json        (npm run plex:check)
    plex-log-warnings.json    (npm run plex:logs)

  Reads only files under output/ — never the media library — so it works with
  the drive unplugged. A command that hasn't run is reported in the file's
  "sources" block with a null count, so a partial report can't be mistaken for
  a clean library.

  Examples:
    npm run report
    npm run report external
  `)
}

function main(): void {
  const parsed = parseRunnerArgs(MEDIA_TYPES)

  if (parsed.kind === 'help') {
    printHelp()
    process.exit(parsed.explicit ? 0 : 1)
  }

  const config: AppConfig = loadConfig(PROJECT_ROOT)
  const acrossAllTypes = parsed.kind === 'all'
  const types: readonly MediaType[] = acrossAllTypes ? MEDIA_TYPES : [parsed.type as MediaType]

  printBanner('Warnings report')

  for (const mediaType of types) {
    const root = selectRoot(config, mediaType, parsed.drive, acrossAllTypes)
    if (!root) continue
    runType(mediaType, root)
  }

  console.log()
}

main()
