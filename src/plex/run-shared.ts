/**
 * plex/run-shared.ts
 * ------------------
 * Pieces shared by the offline `plex:*` runners that write per-drive warnings
 * (`plex:check`, `plex:logs`): the per-type rules they need, the
 * `--no-ignore` review mode, and the warnings write + console summary.
 */

import path from 'path'

import { MediaRootConfig, WarningCollector } from '../core/types'
import { driveSlug } from '../core/config'
import { loadIgnoreList } from '../core/ignored'
import { reportLegacyOutputFiles, typeOutputPaths } from '../core/output-paths'
import { compilePattern } from '../core/rules/helpers'
import { loadTypeRules } from '../core/rules/registry'
import { PROJECT_ROOT } from '../core/project'
import { warningBreakdown, writeWarnings } from '../core/runner-shared'

import { MediaType } from './types'

export { MEDIA_TYPES } from '../core/project'

// ─────────────────────────────────────────────
// --no-ignore
// ─────────────────────────────────────────────

export const NO_IGNORE_FLAG = '--no-ignore'

/** True when the command line asks to skip the ignore lists. */
export function noIgnoreRequested(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes(NO_IGNORE_FLAG)
}

/**
 * Where a warnings file goes. A `--no-ignore` review writes the same file name
 * into `unfiltered/`, so it never replaces the filtered output you work from.
 */
export function warningsPath(
  root: MediaRootConfig,
  mediaType: MediaType,
  name: string,
  unfiltered: boolean
): string {
  const out = typeOutputPaths(PROJECT_ROOT, driveSlug(root.name), mediaType)
  reportLegacyOutputFiles(out)
  return path.join(unfiltered ? out.unfilteredDir : out.dir, `${name}.json`)
}

/** A collector with the drive's ignore list — or none, for a `--no-ignore` review. */
export function plexWarningCollector(
  root: MediaRootConfig,
  mediaType: MediaType,
  unfiltered: boolean
): WarningCollector {
  const { hasCategories } = typeRules(mediaType)
  // An empty list rather than none, so unfiltered rows still carry their
  // ready-to-paste ignore entry.
  return unfiltered
    ? new WarningCollector({ mediaType, entries: [] }, hasCategories)
    : new WarningCollector(
        loadIgnoreList(PROJECT_ROOT, driveSlug(root.name), mediaType),
        hasCategories
      )
}

// ─────────────────────────────────────────────
// Per-type rules
// ─────────────────────────────────────────────

/**
 * What each type contributes: whether its folders are categorized (for
 * ignore-list scope) and, for movies/shows, the folder pattern that yields
 * the title and year Plex's are compared against.
 */
export function typeRules(mediaType: MediaType): {
  hasCategories: boolean
  folderPattern: RegExp | null
} {
  const hasCategories = loadTypeRules(mediaType).categories.length > 0
  switch (mediaType) {
    case 'movies':
      return {
        hasCategories,
        folderPattern: compilePattern(loadTypeRules('movies').patterns.folder),
      }
    case 'shows':
      return {
        hasCategories,
        folderPattern: compilePattern(loadTypeRules('shows').patterns.show_folder),
      }
    case 'music':
    case 'audiobooks':
      return { hasCategories, folderPattern: null }
  }
}

// ─────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────

/** Write the warnings and print the per-type breakdown and silenced count. */
export function writePlexWarnings(outputPath: string, warnings: WarningCollector): void {
  writeWarnings(outputPath, warnings)
  const silenced = warnings.silencedCount()
  if (warnings.count() > 0 || silenced > 0) {
    const breakdown = warningBreakdown(warnings)
    const silencedNote = silenced > 0 ? `${silenced} silenced via ignore list` : ''
    console.log(`    ${[breakdown, silencedNote].filter(Boolean).join(' — ')}`)
  }
}
