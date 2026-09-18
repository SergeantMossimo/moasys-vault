/**
 * media/movies.ts
 * ---------------
 * Movie-specific parsing, serialization, and DB logic for MOASYS-Vault.
 *
 * Expected Plex folder structure (default rules):
 *   <media_folder>/
 *     <Movie Title (YEAR)>/
 *       <Movie Title (YEAR)>.mp4
 *       <Movie Title (YEAR)> {edition-Edition Name}.mp4
 *
 * The patterns and constants that define those conventions live in
 * src/core/rules/movies.ts (with optional YAML overrides in rules/movies.yaml).
 * This file no longer hardcodes regexes or year ranges — it consumes them
 * through the factory below.
 */

import fs from 'fs'
import path from 'path'

import {
  MoviesConfig,
  MovieRecord,
  MovieOutput,
  WarningCollector,
  MediaModule,
} from '../core/types'
import { hasExtension, isPrimary, formatPrimaryExts, findUnexpectedEntries } from '../core/files'
import { MoviesRules } from '../core/rules/movies'
import {
  buildCategoryQualityMap,
  compilePattern,
  isAcceptableCombo,
  qualitySortKey,
  resolveCategories,
  sortQualities,
} from '../core/rules/helpers'
import { distinctCategories, finalizeVersions, groupCategoriesByQuality } from '../core/versions'
import { ProbeData } from '../probe/types'
import { deriveQuality } from '../probe/helpers'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * The remedy for each warning type, written once per bucket in warnings.json
 * rather than repeated on every row — see `WarningOptions.fix`.
 *
 * They live in one map because several types fire from more than one call site
 * (`warn_unexpected_entries` from both the category root and a movie folder,
 * for instance) and a `fix` must read the same whichever site produced the row.
 * Keep each one generic enough to cover every site that uses it, and keep
 * per-row detail in the `issue` instead.
 */
const FIX = {
  warn_loose_files:
    `Plex expects every movie inside its own 'Movie Title (YEAR)/' folder. Move each file ` +
    `into one — loose files are not in the catalog.`,
  warn_unexpected_entries:
    `Expected only movie folders or video files, plus Plex sidecars. Move or delete ` +
    `anything else.`,
  warn_extra_subfolders:
    `Plex expects every video directly inside the 'Movie Title (YEAR)/' folder. Move them ` +
    `up — files in these subfolders are not scanned.`,
  warn_no_videos: `Add the movie file, or delete the empty folder.`,
  warn_non_primary: `Re-encode to your primary format if you want one format throughout.`,
  warn_bad_file_name: `Rename to 'Movie Title (YEAR).ext', matching its folder.`,
  warn_bad_folder_name: `Rename to 'Movie Title (YEAR)', e.g. 'Alien (1979)'.`,
  warn_empty_edition: `Name the edition — '{edition-Director's Cut}' — or drop the tag entirely.`,
  warn_suspicious_year: `Check the year against the real release date; it is usually a typo.`,
  warn_title_mismatch: `Rename the file to match its folder, or move it to the right folder.`,
  warn_title_case:
    `Match the file's capitalization to the folder, so Plex and your filesystem don't ` +
    `present the same movie two ways.`,
  warn_year_mismatch: `Rename the file to match its folder, or move it to the right folder.`,
  warn_duplicate_edition:
    `Two files in one folder claim the same edition, so Plex shows only one. Give each a ` +
    `distinct '{edition-Name}' tag, or delete the redundant file.`,
  warn_duplicate_quality:
    `Same movie at the same quality in two places — one is redundant. Keep the copy in the ` +
    `folder you want and delete the rest.`,
  warn_multi_quality:
    `Expected when you keep a UHD and an HD copy. If it isn't deliberate, delete the ` +
    `redundant copy — or whitelist the pair via acceptable_quality_combos in rules/movies.yaml.`,
  permission_denied: `Check the folder's permissions, or whether the drive is still mounted.`,
} as const

/**
 * Parse a Plex movie folder name using the configured folder pattern.
 * Returns { title, year } or null if the name doesn't match the pattern.
 *
 * The pattern is expected to use named capture groups `title` and `year`.
 */
function parseFolder(name: string, folderRegex: RegExp): { title: string; year: number } | null {
  const m = folderRegex.exec(name)
  if (!m?.groups) return null
  const { title, year } = m.groups
  if (title === undefined || year === undefined) return null
  return { title: title.trim(), year: parseInt(year, 10) }
}

/**
 * Parse a Plex movie file stem using the configured file pattern.
 * Returns { title, year, edition } or null.
 *
 * edition is null (no tag), "" (empty tag like `{edition-}`), or a string.
 * The pattern is expected to use named capture groups `title`, `year`, and
 * optionally `edition`.
 */
function parseFileStem(
  stem: string,
  fileRegex: RegExp
): { title: string; year: number; edition: string | null } | null {
  const m = fileRegex.exec(stem)
  if (!m?.groups) return null
  const { title, year, edition: editionRaw } = m.groups
  if (title === undefined || year === undefined) return null

  let edition: string | null
  if (editionRaw === undefined) {
    edition = null // No {edition-...} tag at all
  } else if (editionRaw.trim() === '') {
    edition = '' // Empty tag: {edition-}
  } else {
    edition = editionRaw.trim()
  }
  return { title: title.trim(), year: parseInt(year, 10), edition }
}

/**
 * Build a unique Map key for a movie record.
 * Lowercased so "The Crow" and "the crow" are treated as the same title.
 */
function makeKey(title: string, year: number, edition: string | null): string {
  return `${title.toLowerCase()}|${year}|${(edition ?? '').toLowerCase()}`
}

/** Build the Plex-style movie name used as the warning path */
function movieDisplayName(record: MovieRecord): string {
  const base = `${record.title} (${record.year})`
  return record.edition ? `${base} {edition-${record.edition}}` : base
}

/** Normalize a path to forward slashes — matches the probe-side cache key. */
function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

/**
 * Create a movies media module bound to the provided rules.
 * Called once at startup by scan.ts after rules are loaded and validated.
 *
 * Rules are captured in closure rather than read from module-level state,
 * so the module is reusable and testable without globals (apart from the
 * qualityOrder slot already established by initTagOrder).
 */
export function createMoviesModule(
  rules: MoviesRules
): MediaModule<MovieRecord, MovieOutput, MoviesConfig> {
  // Compile pattern entries to RegExp objects once at boot. The rules schema
  // already validated that pattern and flags are well-formed, so no try/catch.
  const folderRegex = compilePattern(rules.patterns.folder)
  const fileRegex = compilePattern(rules.patterns.file)

  // year_range.max is resolved to a plain number by the loader, even if the
  // YAML wrote `max: current`. So this assertion is safe.
  const yearMin = rules.year_range.min
  const yearMax = rules.year_range.max as number

  // Resolve the effective category list once: user's configured categories,
  // or the synthetic single-entry default pointing at root_path with label
  // "default" when nothing is configured.
  const effectiveCategories = resolveCategories(rules.categories)
  const categoryOrder = effectiveCategories.map(c => c.name)

  // Map each category name to its auto-detected quality (or the category name
  // itself when quality is null). Used by both postScan quality checks, so
  // that e.g. a movie in `{Other UHD, Other HD}` resolves to `{UHD, HD}` and
  // matches a simple combo entry of `[UHD, HD]`.
  const categoryToQuality = buildCategoryQualityMap(effectiveCategories)

  return {
    getCategories: () => effectiveCategories,

    /**
     * Walk one category folder (e.g. UHD/) and return a Map of movie records.
     * Called once per category entry by core/scanner.ts.
     */
    scanCategory(
      folderPath: string,
      folderName: string,
      category: string,
      config: MoviesConfig,
      warnings: WarningCollector,
      probeByPath: Map<string, ProbeData>
    ): Map<string, MovieRecord> {
      const records = new Map<string, MovieRecord>()

      const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true })

      // Loose video files at media folder level — silently dropped without
      // this check. Plex expects each movie inside a Title (YEAR)/ folder.
      if (rules.checks.warn_loose_files) {
        const looseRoot = rootEntries.filter(
          e => e.isFile() && hasExtension(e.name, rules.video_extensions)
        )
        if (looseRoot.length > 0) {
          warnings.add(
            'warn_loose_files',
            folderName,
            `${looseRoot.length} loose video file(s) in the category root.`,
            { fix: FIX.warn_loose_files }
          )
        }
      }

      // Unexpected non-media, non-sidecar files at media folder root.
      if (rules.checks.warn_unexpected_entries) {
        const unexpected = findUnexpectedEntries(
          rootEntries,
          rules.video_extensions,
          rules.sidecar_extensions
        )
        if (unexpected.length > 0) {
          const names = unexpected.map(e => `'${e.name}'`).join(', ')
          warnings.add(
            'warn_unexpected_entries',
            folderName,
            `Unexpected file(s) in the category root: ${names}.`,
            { fix: FIX.warn_unexpected_entries }
          )
        }
      }

      for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue

        const movieFolderPath = path.join(folderPath, entry.name)
        const folderRel = path.join(folderName, entry.name)
        const parsedFolder = parseFolder(entry.name, folderRegex)

        let allFiles: fs.Dirent[]
        try {
          allFiles = fs.readdirSync(movieFolderPath, { withFileTypes: true })
        } catch {
          warnings.add('permission_denied', folderRel, 'Permission denied reading folder.', {
            fix: FIX.permission_denied,
          })
          continue
        }

        // Subfolders inside a movie folder are silently ignored — any video
        // files in them would be dropped from the catalog.
        if (rules.checks.warn_extra_subfolders) {
          const subfolders = allFiles.filter(e => e.isDirectory())
          if (subfolders.length > 0) {
            const names = subfolders.map(s => `'${s.name}'`).join(', ')
            warnings.add(
              'warn_extra_subfolders',
              folderRel,
              `Unexpected subfolder(s) in the movie folder: ${names}.`,
              { fix: FIX.warn_extra_subfolders }
            )
          }
        }

        // Non-media, non-sidecar files inside a movie folder (e.g. .zip, .txt).
        if (rules.checks.warn_unexpected_entries) {
          const unexpected = findUnexpectedEntries(
            allFiles,
            rules.video_extensions,
            rules.sidecar_extensions
          )
          if (unexpected.length > 0) {
            const names = unexpected.map(e => `'${e.name}'`).join(', ')
            warnings.add(
              'warn_unexpected_entries',
              folderRel,
              `Unexpected file(s) in the movie folder: ${names}.`,
              { fix: FIX.warn_unexpected_entries }
            )
          }
        }

        const videoFiles = allFiles.filter(
          f => f.isFile() && hasExtension(f.name, rules.video_extensions)
        )
        const nonPrimary = videoFiles.filter(f => !isPrimary(f.name, rules.primary_extension))
        const primaryFiles = videoFiles.filter(f => isPrimary(f.name, rules.primary_extension))

        if (videoFiles.length === 0) {
          if (rules.checks.warn_no_videos) {
            warnings.add('warn_no_videos', folderRel, 'Movie folder has no video files.', {
              fix: FIX.warn_no_videos,
            })
          }
          continue
        }

        if (rules.checks.warn_non_primary) {
          for (const f of nonPrimary) {
            const ext = path.extname(f.name).toLowerCase()
            warnings.add(
              'warn_non_primary',
              path.join(folderRel, f.name),
              `${formatPrimaryExts(rules.primary_extension)} video file.`,
              { extension: ext, fix: FIX.warn_non_primary }
            )
          }
        }

        // Track seen editions in this folder to detect duplicates
        const seenEditions = new Map<string, string>()

        for (const f of primaryFiles) {
          const stem = path.basename(f.name, path.extname(f.name))
          const parsed = parseFileStem(stem, fileRegex)

          if (!parsed) {
            if (rules.checks.warn_bad_file_name) {
              warnings.add(
                'warn_bad_file_name',
                path.join(folderRel, f.name),
                `File name is not 'Movie Title (YEAR)'.`,
                { fix: FIX.warn_bad_file_name }
              )
            }
            continue
          }

          const { title: fileTitle, year: fileYear } = parsed
          let { edition } = parsed

          if (edition === '') {
            if (rules.checks.warn_empty_edition) {
              warnings.add(
                'warn_empty_edition',
                path.join(folderRel, f.name),
                '{edition-} has no value after the dash.',
                { fix: FIX.warn_empty_edition }
              )
            }
            edition = null // Treat as no edition so file still gets catalogued
          }

          if (fileYear < yearMin || fileYear > yearMax) {
            if (rules.checks.warn_suspicious_year) {
              warnings.add(
                'warn_suspicious_year',
                path.join(folderRel, f.name),
                `Year ${fileYear} is outside ${yearMin}–${yearMax}.`,
                { fix: FIX.warn_suspicious_year }
              )
            }
          }

          if (!parsedFolder) {
            if (rules.checks.warn_bad_folder_name) {
              warnings.add(
                'warn_bad_folder_name',
                folderRel,
                `Folder name is not 'Movie Title (YEAR)'.`,
                { fix: FIX.warn_bad_folder_name }
              )
            }
          } else {
            const { title: folderTitle, year: folderYear } = parsedFolder

            // Split by severity — see the matching comment in media/shows.ts.
            // A different title is a real problem; a capitalization-only
            // difference is cosmetic and gets its own check so it can't bury
            // the former.
            if (fileTitle.toLowerCase() !== folderTitle.toLowerCase()) {
              if (rules.checks.warn_title_mismatch) {
                warnings.add(
                  'warn_title_mismatch',
                  path.join(folderRel, f.name),
                  `File says '${fileTitle}', folder says '${folderTitle}'.`,
                  { fix: FIX.warn_title_mismatch }
                )
              }
            } else if (fileTitle !== folderTitle) {
              if (rules.checks.warn_title_case) {
                warnings.add(
                  'warn_title_case',
                  path.join(folderRel, f.name),
                  `Capitalization only: file '${fileTitle}' vs folder '${folderTitle}'.`,
                  { fix: FIX.warn_title_case }
                )
              }
            }

            if (fileYear !== folderYear) {
              if (rules.checks.warn_year_mismatch) {
                warnings.add(
                  'warn_year_mismatch',
                  path.join(folderRel, f.name),
                  `File says ${fileYear}, folder says ${folderYear}.`,
                  { fix: FIX.warn_year_mismatch }
                )
              }
            }
          }

          // Duplicate-edition check: two files in same folder claiming same edition
          const editionKey = (edition ?? '').toLowerCase()
          const existing = seenEditions.get(editionKey)
          if (existing !== undefined) {
            if (rules.checks.warn_duplicate_edition) {
              warnings.add(
                'warn_duplicate_edition',
                path.join(folderRel, f.name),
                `'${existing}' already claims ${!edition ? 'no edition' : `'${edition}'`}.`,
                { fix: FIX.warn_duplicate_edition }
              )
            }
          } else {
            seenEditions.set(editionKey, f.name)
          }

          const key = makeKey(fileTitle, fileYear, edition)
          if (!records.has(key)) {
            records.set(key, {
              title: fileTitle,
              year: fileYear,
              edition,
              versions: [],
            })
          }
          // Look up the file's probe data and derive a quality bucket from
          // its dimensions. Quality stays null when the file has no probe
          // entry (e.g. it failed to probe) or when no bucket's range fits.
          const probePath = toRel(path.join(folderName, entry.name, f.name))
          const probe = probeByPath.get(probePath)
          const quality = probe?.video
            ? deriveQuality(probe.video.width, probe.video.height, rules.quality_thresholds)
            : null
          records.get(key)!.versions.push({ category, quality })
        }
      }

      return records
    },

    merge(existing: Map<string, MovieRecord>, incoming: Map<string, MovieRecord>): void {
      for (const [key, record] of incoming) {
        if (existing.has(key)) {
          existing.get(key)!.versions.push(...record.versions)
        } else {
          existing.set(key, record)
        }
      }
    },

    serialize(records: Map<string, MovieRecord>): MovieOutput[] {
      return [...records.values()]
        .map(r => ({
          title: r.title,
          year: r.year,
          edition: r.edition,
          versions: finalizeVersions(r.versions, categoryOrder),
        }))
        .sort((a, b) => {
          const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
          if (t !== 0) return t
          if (a.year !== b.year) return a.year - b.year
          return (a.edition ?? '').localeCompare(b.edition ?? '')
        })
    },

    /**
     * Post-merge quality checks, both driven off one grouping of the movie's
     * categories by quality tier:
     *
     *   - `warn_duplicate_quality` — two or more category folders resolve to
     *     the SAME tier (`HD/` + `Other HD/`), i.e. redundant copies of the
     *     same thing. Never silenced by `acceptable_quality_combos`.
     *   - `warn_multi_quality` — the movie spans more than one tier, and that
     *     tier set isn't whitelisted in `acceptable_quality_combos`.
     *
     * Splitting them matters: `{UHD, HD, Other HD}` collapses to the tier set
     * `{UHD, HD}`, which is the common whitelisted combo — so the third file
     * is invisible to the multi-quality check and only the duplicate check
     * catches it.
     */
    postScan(records: Map<string, MovieRecord>, warnings: WarningCollector): void {
      const duplicateOn = rules.checks.warn_duplicate_quality
      const multiOn = rules.checks.warn_multi_quality
      if (!duplicateOn && !multiOn) return

      for (const record of records.values()) {
        const byQuality = groupCategoriesByQuality(record.versions, categoryToQuality)

        if (duplicateOn) {
          for (const quality of sortQualities(byQuality.keys())) {
            const cats = byQuality.get(quality)!
            if (cats.length <= 1) continue
            warnings.add(
              'warn_duplicate_quality',
              movieDisplayName(record),
              `Duplicate ${quality} copies in ${cats.length} folders: ${cats.join(', ')}.`,
              {
                fix: FIX.warn_duplicate_quality,
                // Group the bucket by quality (UHD, then HD, then SD) rather
                // than by title, so the worst offenders read together.
                sortKey: qualitySortKey(quality),
                // The path here is a display label, not a library path — this
                // check spans categories by definition, so there's no single
                // one to anchor to. Spell the scope out or no ignore entry
                // could ever reach it.
                scope: { categories: cats, levels: [movieDisplayName(record)] },
              }
            )
          }
        }

        if (multiOn) {
          const qualities = new Set(byQuality.keys())
          if (
            qualities.size > 1 &&
            !isAcceptableCombo(qualities, rules.acceptable_quality_combos)
          ) {
            warnings.add(
              'warn_multi_quality',
              movieDisplayName(record),
              `Exists in multiple qualities: ${sortQualities(qualities).join(', ')}.`,
              // Display label, not a library path — see warn_duplicate_quality.
              {
                fix: FIX.warn_multi_quality,
                scope: {
                  categories: distinctCategories(record.versions),
                  levels: [movieDisplayName(record)],
                },
              }
            )
          }
        }
      }
    },
  }
}
