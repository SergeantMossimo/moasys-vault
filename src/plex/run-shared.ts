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
import { compilePattern } from '../core/rules/helpers'
import { loadRules } from '../core/rules/loader'
import { MoviesRulesSchema, defaultMoviesRules } from '../core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from '../core/rules/shows'
import { MusicRulesSchema, defaultMusicRules } from '../core/rules/music'
import { AudiobooksRulesSchema, defaultAudiobooksRules } from '../core/rules/audiobooks'
import { writeWarnings } from '../core/runner-shared'

import { OUTPUT_DIR, SCRIPT_DIR } from './setup'
import { MediaType } from './types'

export const MEDIA_TYPES: MediaType[] = ['movies', 'shows', 'music', 'audiobooks']

// ─────────────────────────────────────────────
// --no-ignore
// ─────────────────────────────────────────────

export const NO_IGNORE_FLAG = '--no-ignore'

/** True when the command line asks to skip the ignore lists. */
export function noIgnoreRequested(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes(NO_IGNORE_FLAG)
}

/**
 * Where a warnings file goes. A `--no-ignore` review writes
 * `<name>.unfiltered.json` beside the normal file, so it never replaces the
 * filtered output you work from.
 */
export function warningsPath(
  root: MediaRootConfig,
  mediaType: MediaType,
  name: string,
  unfiltered: boolean
): string {
  const file = unfiltered ? `${name}.unfiltered.json` : `${name}.json`
  return path.join(OUTPUT_DIR, driveSlug(root.name), mediaType, file)
}

/** A collector with the drive's ignore list — or none, for a `--no-ignore` review. */
export function plexWarningCollector(
  root: MediaRootConfig,
  mediaType: MediaType,
  unfiltered: boolean
): WarningCollector {
  const { hasCategories } = typeRules(mediaType)
  return unfiltered
    ? new WarningCollector(undefined, hasCategories)
    : new WarningCollector(
        loadIgnoreList(SCRIPT_DIR, driveSlug(root.name), mediaType),
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
// Output
// ─────────────────────────────────────────────

/** Write the warnings and print the per-type breakdown and silenced count. */
export function writePlexWarnings(outputPath: string, warnings: WarningCollector): void {
  writeWarnings(outputPath, warnings)
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
