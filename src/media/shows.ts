/**
 * media/shows.ts
 * --------------
 * Show-specific parsing, serialization, and DB logic for MOASYS-Vault.
 *
 * Expected Plex folder structure (default rules):
 *   <media_folder>/
 *     <Show Title (YEAR)>/
 *       Season 01/
 *         <Show Title (YEAR)> - S01E01 - Episode Title.mp4
 *         <Show Title (YEAR)> - S01E01-E02 - Multi Episode Title.mp4
 *       Specials/              ← named season from ignored_season_names rules
 *         <Show Title (YEAR)> - S00E01 - Special Title.mp4
 *
 * Patterns and ignored_season_names come from src/core/rules/shows.ts
 * (with optional YAML overrides in rules/shows.yaml).
 */

import fs from 'fs'
import path from 'path'

import {
  EpisodeOutput,
  ShowsConfig,
  ShowRecord,
  ShowOutput,
  WarningCollector,
  MediaModule,
} from '../core/types'
import { hasExtension, isPrimary, formatPrimaryExts, findUnexpectedEntries } from '../core/files'
import { findNumericGaps, formatGaps } from '../core/gaps'
import { ShowsRules } from '../core/rules/shows'
import {
  buildCategoryQualityMap,
  canonicalEpisodeCode,
  compilePattern,
  extractEpisodeCode,
  isAcceptableCombo,
  resolveCategories,
  LENIENT_EPISODE_FILE,
  sortQualities,
} from '../core/rules/helpers'
import { distinctCategories, finalizeVersions, groupCategoriesByQuality } from '../core/versions'
import { ProbeData } from '../probe/types'
import { deriveQuality } from '../probe/helpers'

// ─────────────────────────────────────────────
// Fix advice
// ─────────────────────────────────────────────

/**
 * The remedy for each warning type. Not written to warnings.json — the remedy
 * is identical on every row of a type, so its home is the warning tables in
 * docs/OUTPUT.md. Kept here so it sits beside the check it belongs to, and so
 * one wording is shared when a type fires from several call sites.
 *
 * They live in one map because several types fire from more than one call site
 * (`warn_loose_files` from both the category root and a show folder, for
 * instance) and a `fix` must read the same whichever site produced the row.
 * Keep each one generic enough to cover every site that uses it, and keep
 * per-row detail in the `issue` instead.
 */
const FIX = {
  warn_loose_files:
    `Plex expects every episode inside 'Show Title (YEAR)/Season XX/'. Move them into one — ` +
    `loose files are not in the catalog.`,
  warn_unexpected_entries:
    `Expected only subfolders plus Plex sidecars (poster, banner, fanart, NFO, subtitles). ` +
    `Move or delete anything else.`,
  warn_extra_subfolders:
    `Plex expects every episode directly inside the Season XX folder. Move them up — ` +
    `files in these subfolders are not scanned.`,
  warn_bad_show_folder:
    `Rename to 'Show Title (YEAR)', e.g. 'Firefly (2002)'. A second cut of the same series ` +
    `takes Plex's edition tag: 'Firefly (2002) {edition-Remastered}'.`,
  warn_empty_edition:
    `Name the edition, e.g. '{edition-Black and White}', or drop the tag. Treated as no ` +
    `edition until then.`,
  warn_bad_season_folder:
    `Rename to 'Season 01'. If it is a real named season, add the name to ` +
    `ignored_season_names in rules/shows.yaml.`,
  warn_bad_file_name:
    `Rename to 'Show Title (YEAR) - S01E01 - Episode Title.ext' (the title is optional). ` +
    `Fix with: npm run fix:shows -- --fix episode-code <drive> --apply`,
  warn_missing_episode_title:
    `Rename to include the title, e.g. 'Show (2020) - S01E01 - Pilot.mp4'. ` +
    `Plex catalogues them either way — this is for a tidier library.`,
  warn_episode_code_case: `Fix with: npm run fix:shows -- --fix episode-code <drive> --apply`,
  warn_show_year_mismatch:
    `Rename the file's show/year to match its folder, or move it to the right show. ` +
    `Fix with: npm run fix:shows -- --fix show-prefix <drive> --apply`,
  warn_show_title_case:
    `Match the file's capitalization to the folder, so Plex and your filesystem don't ` +
    `present the same show two ways. Fix with: npm run fix:shows -- --fix show-prefix <drive> --apply`,
  warn_season_mismatch: `Move the file to the season folder its code names, or fix the code.`,
  warn_episode_gaps: `Add the missing episodes, or ignore this if the show really skips them.`,
  warn_no_videos: `Add the episodes, or delete the empty folder.`,
  warn_non_primary: `Re-encode to your primary format if you want one format throughout.`,
  warn_quality_mismatch:
    `Move the season to the folder matching its resolution, or replace the files with a ` +
    `better source.`,
  warn_multi_quality:
    `Expected when you keep a UHD and an HD copy. If it isn't deliberate, delete the ` +
    `redundant copy — or whitelist the pair via acceptable_quality_combos in rules/shows.yaml.`,
  warn_duplicate_quality:
    `Same season at the same quality in two places — one is redundant. Keep the copy in ` +
    `the folder you want and delete the rest.`,
  permission_denied: `Check the folder's permissions, or whether the drive is still mounted.`,
} as const

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Parse a show folder name using the configured pattern.
 * Returns { title, year, edition } or null.
 *
 * `edition` is Plex's TV Show Editions tag and follows the same three-state
 * convention as the movies file parser: null (no `{edition-...}` tag at all),
 * "" (an empty `{edition-}`), or the trimmed name.
 */
function parseShowFolder(
  name: string,
  regex: RegExp
): { title: string; year: number; edition: string | null } | null {
  const m = regex.exec(name)
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

function parseSeasonFolder(name: string, regex: RegExp): number | null {
  const m = regex.exec(name)
  if (!m?.groups) return null
  const season = m.groups.season
  if (season === undefined) return null
  return parseInt(season, 10)
}

/**
 * Parse an episode file stem. Returns first/last episode numbers — equal for
 * single-episode files, different for multi-episode files (S01E01-E02 → 1, 2).
 * episode_end is optional in the pattern; absent means single-episode.
 */
function parseFileStem(
  stem: string,
  regex: RegExp
): {
  title: string
  year: number
  season: number
  firstEpisode: number
  lastEpisode: number
  episodeTitle: string | null
} | null {
  const m = regex.exec(stem)
  if (!m?.groups) return null
  const { title, year, season, episode, episode_end, episode_title } = m.groups
  if (title === undefined || year === undefined || season === undefined || episode === undefined) {
    return null
  }
  const first = parseInt(episode, 10)
  const last = episode_end !== undefined ? parseInt(episode_end, 10) : first
  const trimmedEpisodeTitle = episode_title?.trim()
  return {
    title: title.trim(),
    year: parseInt(year, 10),
    season: parseInt(season, 10),
    firstEpisode: first,
    lastEpisode: last,
    episodeTitle:
      trimmedEpisodeTitle !== undefined && trimmedEpisodeTitle.length > 0
        ? trimmedEpisodeTitle
        : null,
  }
}

/**
 * Build a unique Map key for a show record.
 * Lowercased so "Firefly" and "firefly" are treated as the same title, and
 * keyed on edition so two editions of one series stay separate records —
 * without it they'd merge and their episodes would dedupe against each other.
 */
function makeShowKey(title: string, year: number, edition: string | null): string {
  return `${title.toLowerCase()}|${year}|${(edition ?? '').toLowerCase()}`
}

function makeSeasonKey(
  title: string,
  year: number,
  edition: string | null,
  seasonLabel: string
): string {
  return `${makeShowKey(title, year, edition)}|${seasonLabel.toLowerCase()}`
}

/** Build the Plex-style show folder name used as the warning path */
function showDisplayName(record: { title: string; year: number; edition: string | null }): string {
  const base = `${record.title} (${record.year})`
  return record.edition ? `${base} {edition-${record.edition}}` : base
}

/**
 * Sort key for season labels — numeric seasons first (in numeric order),
 * then named seasons alphabetically.
 * e.g. "1", "2", "10", "Champion of Champions", "Specials"
 */
function seasonSortKey(label: string): [number, number, string] {
  const n = parseInt(label, 10)
  if (!isNaN(n)) return [0, n, '']
  return [1, 0, label.toLowerCase()]
}

/** Normalize a path to forward slashes — matches the probe-side cache key. */
function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export function createShowsModule(
  rules: ShowsRules
): MediaModule<ShowRecord, ShowOutput, ShowsConfig> {
  const showFolderRegex = compilePattern(rules.patterns.show_folder)
  const seasonFolderRegex = compilePattern(rules.patterns.season_folder)
  const fileRegex = compilePattern(rules.patterns.file)

  // Pre-lowercase the ignored names once rather than on every season check.
  const ignoredNamesLower = rules.ignored_season_names.map(n => n.toLowerCase())

  const effectiveCategories = resolveCategories(rules.categories)
  const categoryOrder = effectiveCategories.map(c => c.name)

  // Map each category name to its auto-detected quality (or the category
  // name itself when quality is null). Used by both per-season postScan
  // quality checks so {Other HD, SD} resolves to qualities {HD, SD}.
  const categoryToQuality = buildCategoryQualityMap(effectiveCategories)

  return {
    getCategories: () => effectiveCategories,

    scanCategory(
      folderPath: string,
      folderName: string,
      category: string,
      config: ShowsConfig,
      warnings: WarningCollector,
      probeByPath: Map<string, ProbeData>
    ): Map<string, ShowRecord> {
      const records = new Map<string, ShowRecord>()

      const rootEntries = fs.readdirSync(folderPath, { withFileTypes: true })

      // Loose video files at media folder level — silently dropped without
      // this check. Plex expects each show inside a Show Title (YEAR)/ folder.
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

      for (const showEntry of rootEntries) {
        if (!showEntry.isDirectory()) continue

        const showPath = path.join(folderPath, showEntry.name)
        const showRel = path.join(folderName, showEntry.name)
        const parsedShow = parseShowFolder(showEntry.name, showFolderRegex)

        if (!parsedShow) {
          if (rules.checks.warn_bad_show_folder) {
            warnings.add(
              'warn_bad_show_folder',
              showRel,
              `Folder name is not 'Show Title (YEAR)'.`,
              { fix: FIX.warn_bad_show_folder }
            )
          }
          continue
        }

        const { title: showTitle, year: showYear } = parsedShow
        let showEdition = parsedShow.edition

        if (showEdition === '') {
          if (rules.checks.warn_empty_edition) {
            warnings.add('warn_empty_edition', showRel, '{edition-} has no value after the dash.', {
              fix: FIX.warn_empty_edition,
            })
          }
          showEdition = null // Treat as no edition so the show is still catalogued
        }

        let seasonEntries: fs.Dirent[]
        try {
          seasonEntries = fs.readdirSync(showPath, { withFileTypes: true })
        } catch {
          warnings.add('permission_denied', showRel, 'Permission denied reading show folder.', {
            fix: FIX.permission_denied,
          })
          continue
        }

        // Loose video files in the show folder (no Season XX folder around
        // them) — silently dropped from the catalog without this check.
        if (rules.checks.warn_loose_files) {
          const looseShow = seasonEntries.filter(
            e => e.isFile() && hasExtension(e.name, rules.video_extensions)
          )
          if (looseShow.length > 0) {
            warnings.add(
              'warn_loose_files',
              showRel,
              `${looseShow.length} loose video file(s) in the show folder, outside any season.`,
              { fix: FIX.warn_loose_files }
            )
          }
        }

        // Unexpected non-media, non-sidecar files in the show folder.
        // Sidecars (show poster, banner, fanart, NFO) are silently allowed.
        if (rules.checks.warn_unexpected_entries) {
          const unexpected = findUnexpectedEntries(
            seasonEntries,
            rules.video_extensions,
            rules.sidecar_extensions
          )
          if (unexpected.length > 0) {
            const names = unexpected.map(e => `'${e.name}'`).join(', ')
            warnings.add(
              'warn_unexpected_entries',
              showRel,
              `Unexpected file(s) in the show folder: ${names}.`,
              { fix: FIX.warn_unexpected_entries }
            )
          }
        }

        for (const seasonEntry of seasonEntries) {
          if (!seasonEntry.isDirectory()) continue

          const seasonPath = path.join(showPath, seasonEntry.name)
          const seasonRel = path.join(showRel, seasonEntry.name)
          const nameLower = seasonEntry.name.toLowerCase()

          // ── Determine season label ───────────────────────────────────────
          let seasonLabel: string
          let isNamed: boolean

          if (ignoredNamesLower.includes(nameLower)) {
            // Named season from rules (e.g. "Specials") — use as-is
            seasonLabel = seasonEntry.name
            isNamed = true
          } else {
            const seasonNumber = parseSeasonFolder(seasonEntry.name, seasonFolderRegex)
            if (seasonNumber === null) {
              if (rules.checks.warn_bad_season_folder) {
                warnings.add(
                  'warn_bad_season_folder',
                  seasonRel,
                  `Folder name is not 'Season 01' and is not in ignored_season_names.`,
                  { fix: FIX.warn_bad_season_folder }
                )
              }
              continue
            }
            seasonLabel = String(seasonNumber) // "01" -> "1"
            isNamed = false
          }

          // ── Read episode files ───────────────────────────────────────────
          let allFiles: fs.Dirent[]
          try {
            allFiles = fs.readdirSync(seasonPath, { withFileTypes: true })
          } catch {
            warnings.add(
              'permission_denied',
              seasonRel,
              'Permission denied reading season folder.',
              {
                fix: FIX.permission_denied,
              }
            )
            continue
          }

          // Subfolders inside a season are silently ignored — any files in
          // them would be dropped from the catalog.
          if (rules.checks.warn_extra_subfolders) {
            const subfolders = allFiles.filter(e => e.isDirectory())
            if (subfolders.length > 0) {
              const names = subfolders.map(s => `'${s.name}'`).join(', ')
              warnings.add(
                'warn_extra_subfolders',
                seasonRel,
                `Unexpected subfolder(s) in the season folder: ${names}.`,
                { fix: FIX.warn_extra_subfolders }
              )
            }
          }

          // Non-media, non-sidecar files inside the season folder.
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
                seasonRel,
                `Unexpected file(s) in the season folder: ${names}.`,
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
              warnings.add('warn_no_videos', seasonRel, 'Season folder has no video files.', {
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
                path.join(seasonRel, f.name),
                `${formatPrimaryExts(rules.primary_extension)} video file.`,
                { extension: ext, fix: FIX.warn_non_primary }
              )
            }
          }

          const episodeNumbers: number[] = []
          const episodes: EpisodeOutput[] = []
          let seasonEpCount = 0
          let parsedFilesInSeason = 0
          let filesMissingTitleInSeason = 0
          let filesOffStyleCodeInSeason = 0
          let offStyleCodeSample: string | null = null

          for (const f of primaryFiles) {
            const stem = path.basename(f.name, path.extname(f.name))
            const parsed = parseFileStem(stem, fileRegex)

            if (!parsed) {
              if (rules.checks.warn_bad_file_name) {
                warnings.add(
                  'warn_bad_file_name',
                  path.join(seasonRel, f.name),
                  LENIENT_EPISODE_FILE.test(stem)
                    ? 'Episode code is not canonical (e.g. s02e4, S010e01, -S01e01 with no space).'
                    : `File name is not 'Show Title (YEAR) - S01E01 - Episode Title'.`,
                  { fix: FIX.warn_bad_file_name }
                )
              }
              continue
            }

            const {
              title: fileTitle,
              year: fileYear,
              season: fileSeason,
              firstEpisode,
              lastEpisode,
              episodeTitle,
            } = parsed

            // Three outcomes, deliberately split. A file naming a different
            // show (or year) is a real problem; one that differs only in
            // capitalization is cosmetic. Folding them into one bucket buries
            // the former under the latter, so capitalization gets its own
            // low-severity check — the same split `warn_tmdb_title_canonical`
            // already makes against TMDB's canonical title.
            const titlesMatchLoosely = fileTitle.toLowerCase() === showTitle.toLowerCase()
            if (!titlesMatchLoosely || fileYear !== showYear) {
              if (rules.checks.warn_show_year_mismatch) {
                warnings.add(
                  'warn_show_year_mismatch',
                  path.join(seasonRel, f.name),
                  `File says '${fileTitle} (${fileYear})', folder says '${showEntry.name}'.`,
                  { fix: FIX.warn_show_year_mismatch }
                )
              }
            } else if (fileTitle !== showTitle) {
              if (rules.checks.warn_show_title_case) {
                warnings.add(
                  'warn_show_title_case',
                  path.join(seasonRel, f.name),
                  `Capitalization only: file '${fileTitle}' vs folder '${showTitle}'.`,
                  { fix: FIX.warn_show_title_case }
                )
              }
            }

            if (!isNamed && fileSeason !== parseInt(seasonLabel, 10)) {
              if (rules.checks.warn_season_mismatch) {
                warnings.add(
                  'warn_season_mismatch',
                  path.join(seasonRel, f.name),
                  `File says S${String(fileSeason).padStart(2, '0')}, folder says '${seasonEntry.name}'.`,
                  { fix: FIX.warn_season_mismatch }
                )
              }
            }

            parsedFilesInSeason++
            if (episodeTitle === null) filesMissingTitleInSeason++

            // Episode-code house style. Compares the RAW code text, since the
            // parsed values above have already lost the casing the user wrote.
            if (rules.episode_code_case !== 'any') {
              const rawCode = extractEpisodeCode(stem, fileYear)
              const wantCode = canonicalEpisodeCode(
                {
                  seasonNumber: fileSeason,
                  episodeStart: firstEpisode,
                  episodeEnd: lastEpisode,
                },
                rules.episode_code_case
              )
              if (rawCode !== null && rawCode !== wantCode) {
                filesOffStyleCodeInSeason++
                offStyleCodeSample ??= `'${rawCode}' should be '${wantCode}'`
              }
            }

            episodes.push({
              episode_start: firstEpisode,
              episode_end: lastEpisode,
              title: episodeTitle,
            })

            // Add each individual episode number for gap detection
            for (let ep = firstEpisode; ep <= lastEpisode; ep++) {
              episodeNumbers.push(ep)
            }
            seasonEpCount += lastEpisode - firstEpisode + 1
          }

          if (rules.checks.warn_episode_gaps) {
            const gaps = findNumericGaps(episodeNumbers)
            if (gaps.length > 0) {
              const gapStr = formatGaps(gaps, g => `E${String(g).padStart(2, '0')}`)
              warnings.add(
                'warn_episode_gaps',
                seasonRel,
                `Missing episodes (${gaps.length}): ${gapStr}.`,
                { fix: FIX.warn_episode_gaps }
              )
            }
          }

          // Per-season summary: episodes that parsed cleanly but omit the
          // trailing " - Episode Title". One warning per season rather than
          // per file so the warnings list stays scannable.
          if (rules.checks.warn_missing_episode_title && filesMissingTitleInSeason > 0) {
            warnings.add(
              'warn_missing_episode_title',
              seasonRel,
              `${filesMissingTitleInSeason}/${parsedFilesInSeason} episode files have no " - Episode Title".`,
              { fix: FIX.warn_missing_episode_title }
            )
          }

          // Per-season summary, same shape as warn_missing_episode_title
          // above — one line per season rather than one per file, since a
          // library that drifted on casing usually drifted wholesale.
          if (rules.checks.warn_episode_code_case && filesOffStyleCodeInSeason > 0) {
            warnings.add(
              'warn_episode_code_case',
              seasonRel,
              `${filesOffStyleCodeInSeason}/${parsedFilesInSeason} episode codes aren't ` +
                `'${rules.episode_code_case}' style — e.g. ${offStyleCodeSample}.`,
              { fix: FIX.warn_episode_code_case }
            )
          }

          // ── Add season to records ────────────────────────────────────────
          const showKey = makeShowKey(showTitle, showYear, showEdition)
          const seasonKey = makeSeasonKey(showTitle, showYear, showEdition, seasonLabel)

          if (!records.has(showKey)) {
            records.set(showKey, {
              title: showTitle,
              year: showYear,
              edition: showEdition,
              seasons: new Map(),
            })
          }

          const show = records.get(showKey)!
          if (!show.seasons.has(seasonKey)) {
            show.seasons.set(seasonKey, {
              season_label: seasonLabel,
              episode_count: 0,
              versions: [],
              episodes: [],
            })
          }

          const season = show.seasons.get(seasonKey)!
          season.episode_count += seasonEpCount
          for (const ep of episodes) {
            // Skip duplicate episode_start values — the same episode showing
            // up in multiple categories should not be double-listed.
            if (!season.episodes.some(existing => existing.episode_start === ep.episode_start)) {
              season.episodes.push(ep)
            }
          }
          // Push one version per probed episode file. dedupVersions collapses
          // identical (category, quality) entries at serialize time, so a
          // uniform-quality season produces one version while a mixed-quality
          // one produces multiple — accurate to what's on disk.
          for (const f of primaryFiles) {
            const probePath = toRel(path.join(seasonRel, f.name))
            const probe = probeByPath.get(probePath)
            const quality = probe?.video
              ? deriveQuality(probe.video.width, probe.video.height, rules.quality_thresholds)
              : null
            season.versions.push({ category, quality })
          }
        }
      }

      return records
    },

    merge(existing: Map<string, ShowRecord>, incoming: Map<string, ShowRecord>): void {
      for (const [showKey, newShow] of incoming) {
        if (!existing.has(showKey)) {
          existing.set(showKey, newShow)
          continue
        }
        const existingShow = existing.get(showKey)!
        for (const [seasonKey, newSeason] of newShow.seasons) {
          if (!existingShow.seasons.has(seasonKey)) {
            existingShow.seasons.set(seasonKey, newSeason)
          } else {
            const existingSeason = existingShow.seasons.get(seasonKey)!
            existingSeason.versions.push(...newSeason.versions)
            existingSeason.episode_count = Math.max(
              existingSeason.episode_count,
              newSeason.episode_count
            )
            for (const ep of newSeason.episodes) {
              if (
                !existingSeason.episodes.some(
                  existing => existing.episode_start === ep.episode_start
                )
              ) {
                existingSeason.episodes.push(ep)
              }
            }
          }
        }
      }
    },

    serialize(records: Map<string, ShowRecord>): ShowOutput[] {
      return [...records.values()]
        .sort((a, b) => {
          const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase())
          if (t !== 0) return t
          if (a.year !== b.year) return a.year - b.year
          // Editions of one series sort together, untagged first.
          return (a.edition ?? '').toLowerCase().localeCompare((b.edition ?? '').toLowerCase())
        })
        .map(show => ({
          title: show.title,
          year: show.year,
          edition: show.edition,
          seasons: [...show.seasons.values()]
            .sort((a, b) => {
              const [ag0, ag1, as2] = seasonSortKey(a.season_label)
              const [bg0, bg1, bs2] = seasonSortKey(b.season_label)
              if (ag0 !== bg0) return ag0 - bg0
              if (ag1 !== bg1) return ag1 - bg1
              return as2.localeCompare(bs2)
            })
            .map(s => ({
              season: s.season_label,
              episode_count: s.episode_count,
              versions: finalizeVersions(s.versions, categoryOrder),
              episodes: [...s.episodes].sort((a, b) => a.episode_start - b.episode_start),
            })),
        }))
    },

    /**
     * Post-merge quality checks, both scoped per (show, season) and driven off
     * one grouping of that season's categories by quality tier:
     *
     *   - `warn_duplicate_quality` — the season sits in two or more category
     *     folders resolving to the SAME tier (`HD/` + `Other HD/`), i.e.
     *     redundant copies. Never silenced by `acceptable_quality_combos`.
     *   - `warn_multi_quality` — the season spans more than one tier and that
     *     tier set isn't whitelisted in `acceptable_quality_combos`.
     *
     * Per-season scope means different seasons in different qualities (S01
     * DVD, S02-S08 Bluray) trigger neither — each season sees exactly one
     * category. Splitting the two matters because `{UHD, HD, Other HD}`
     * collapses to the tier set `{UHD, HD}`, the common whitelisted combo,
     * so only the duplicate check catches that third copy.
     */
    postScan(records: Map<string, ShowRecord>, warnings: WarningCollector): void {
      const duplicateOn = rules.checks.warn_duplicate_quality
      const multiOn = rules.checks.warn_multi_quality
      if (!duplicateOn && !multiOn) return

      for (const show of records.values()) {
        for (const season of show.seasons.values()) {
          // The show level must be the folder name as it sits on disk —
          // edition tag included — or an ignore entry for one edition would
          // silence the other too.
          const showFolderName = showDisplayName(show)
          const warningPath = `${showFolderName} — Season ${season.season_label}`
          const byQuality = groupCategoriesByQuality(season.versions, categoryToQuality)

          // `warningPath` is a display label — em-dash separated, with no
          // category — so scope derivation can't read levels off it. Spell
          // them out, or no ignore entry could ever reach these two checks.
          // `Season 1` folds onto the on-disk `Season 01` in core/ignored.ts,
          // so one `seasons:` entry covers this and the scan pass alike.
          const seasonLevels = [showFolderName, `Season ${season.season_label}`]

          if (duplicateOn) {
            for (const quality of sortQualities(byQuality.keys())) {
              const cats = byQuality.get(quality)!
              if (cats.length <= 1) continue
              warnings.add(
                'warn_duplicate_quality',
                warningPath,
                `Duplicate ${quality} copies in ${cats.length} folders: ${cats.join(', ')}.`,
                {
                  fix: FIX.warn_duplicate_quality,
                  scope: { categories: cats, levels: seasonLevels },
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
                warningPath,
                `Exists in multiple qualities: ${sortQualities(qualities).join(', ')}.`,
                {
                  fix: FIX.warn_multi_quality,
                  scope: {
                    categories: distinctCategories(season.versions),
                    levels: seasonLevels,
                  },
                }
              )
            }
          }
        }
      }
    },
  }
}
