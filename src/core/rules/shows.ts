/**
 * core/rules/shows.ts
 * -------------------
 * Schema, defaults, and inferred type for the Shows rules layer.
 *
 * Mirrors the previously hardcoded regex and constants in src/media/shows.ts.
 * `ignored_season_names` used to live in config.json — moved here since it
 * describes a Plex naming convention, not a per-user library path.
 */

import { z } from 'zod'

import { PatternSchema, CategorySchema } from './helpers'

export const ShowsRulesSchema = z.object({
  /**
   * Regex patterns for show, season, and episode names.
   * - `show_folder` must capture: title, year, and optionally edition
   * - `season_folder` must capture: season (number string, will be parseInt'd)
   * - `file` must capture: title, year, season, episode, and optionally episode_end
   *
   * `season_folder` and `file` default to case-insensitive matching (`flags: 'i'`)
   * so `season 01` and `s01e01` are accepted too.
   *
   * The optional `edition` group on `show_folder` is Plex's TV Show Editions
   * convention — `Show Title (YEAR) {edition-Name}`. Plex defines an edition at
   * the SHOW level only, never per-season or per-episode, so `file` carries no
   * edition group: episodes inside an edition folder are named normally.
   */
  patterns: z.object({
    show_folder: PatternSchema,
    season_folder: PatternSchema,
    file: PatternSchema,
  }),

  /** Subfolders under root_path to walk. Empty = walk root_path directly with "default" label. */
  categories: z.array(CategorySchema),

  /** Expected primary file format(s) for episodes. */
  primary_extension: z.array(z.string()).min(1),

  /** All file extensions the scanner recognizes as video files. */
  video_extensions: z.array(z.string()).min(1),

  /**
   * Season folder names that bypass the season-folder regex check.
   * Useful for Plex special-season conventions like "Specials" or
   * library-specific named events.
   */
  ignored_season_names: z.array(z.string()),

  /**
   * House style for the season/episode code in a filename — whether you write
   * `s01e01` or `S01E01`. Plex accepts either, and `patterns.file` is
   * case-insensitive, so this is purely about a library reading consistently.
   *
   *   'lower'  — s01e01, and s01e01-e02 for multi-episode files
   *   'upper'  — S01E01, and S01E01-E02
   *   'any'    — no house style; never warn (the neutral default)
   *
   * Whichever style is set, the multi-episode suffix must spell the letter
   * out (`s01e01-e02`, not the bare `s01e01-02`), since the bare form reads
   * as a range of two different things depending on who's looking.
   *
   * Drives `warn_episode_code_case` and the `episode-code` fix mode in
   * `src/tools/rename-shows.ts`, which share `canonicalEpisodeCode()` so the
   * warning and the fix can never disagree.
   */
  episode_code_case: z.enum(['lower', 'upper', 'any']),

  /**
   * File extensions for Plex sidecar files (NFO metadata, posters,
   * subtitles, etc.). Silently allowed anywhere in the shows hierarchy
   * and never flagged as "unexpected".
   */
  sidecar_extensions: z.array(z.string()),

  /**
   * Quality buckets for ffprobe-driven validation. Same shape and behavior
   * as movies — see src/core/rules/movies.ts for details. Empty by default.
   */
  quality_thresholds: z.array(
    z.object({
      name: z.string(),
      min_width: z.number().int().positive().optional(),
      max_width: z.number().int().positive().optional(),
    })
  ),

  /**
   * Per-season cross-quality combos that are intentional and should NOT
   * trigger the multi-quality warning for a season. Examples: a series whose
   * S01 you bought on DVD (SD) and S02-S08 on Bluray (HD) won't fire — those
   * are different seasons in different qualities. The check fires only when
   * a SINGLE season has copies in multiple qualities (e.g. you have S01 on
   * both DVD and Bluray). Comparison is set-based — order doesn't matter.
   *
   * Silences `warn_multi_quality` only. A combo lists which quality TIERS may
   * coexist, so it can never silence `warn_duplicate_quality` — a season in
   * `HD/` + `Other HD/` + `UHD/` still resolves to the tier set {UHD, HD} and
   * matches `[UHD, HD]`, but the two HD-tier copies are reported regardless.
   */
  acceptable_quality_combos: z.array(z.array(z.string())),

  /** Per-warning toggles. */
  checks: z.object({
    warn_non_primary: z.boolean(),
    warn_no_videos: z.boolean(),
    warn_bad_show_folder: z.boolean(),
    /**
     * A show folder carries `{edition-}` with nothing after the dash. Plex
     * reads that as an empty edition name; the scanner treats it as no edition
     * at all so the show is still catalogued. Mirrors the movies rule of the
     * same name — warnings files are per-type, so the shared name is fine.
     */
    warn_empty_edition: z.boolean(),
    warn_bad_season_folder: z.boolean(),
    warn_bad_file_name: z.boolean(),
    warn_show_year_mismatch: z.boolean(),
    /**
     * The file's show title matches its folder except for capitalization
     * ('My Name is Earl' in a 'My Name Is Earl (2005)' folder). Split out
     * from `warn_show_year_mismatch`, which lowercases both sides and so
     * cannot see this at all, because a cosmetic difference shouldn't share
     * a bucket with a file naming the wrong show.
     */
    warn_show_title_case: z.boolean(),
    /**
     * The season/episode code doesn't match the `episode_code_case` house
     * style, or a multi-episode file uses the bare `-02` suffix instead of
     * the canonical `-e02`. Never fires when `episode_code_case` is 'any'.
     * Summarised once per season.
     */
    warn_episode_code_case: z.boolean(),
    warn_season_mismatch: z.boolean(),
    warn_episode_gaps: z.boolean(),
    warn_quality_mismatch: z.boolean(),
    /**
     * A SINGLE season exists in two or more category folders that resolve to
     * the SAME quality tier (e.g. S01 is in both `HD/` and `Other HD/`) —
     * redundant copies of the same episodes. Per-season scope, so S01 in
     * `HD/` and S02 in `Other HD/` does NOT trigger this. Deliberately NOT
     * silenceable via `acceptable_quality_combos`: those describe which tiers
     * may coexist, not how many copies may sit inside one tier.
     */
    warn_duplicate_quality: z.boolean(),
    /**
     * A SINGLE season exists in multiple distinct qualities (e.g. S01 is in
     * both HD and SD). Per-season scope — different seasons in different
     * qualities (S01 DVD, S02 Bluray) do NOT trigger this.
     */
    warn_multi_quality: z.boolean(),
    /**
     * Video files found at a level where the scanner expects a subfolder.
     * Examples: files directly in a media folder (no show), or directly in
     * a show folder (no season subfolder). Silently dropped without this
     * warning enabled.
     */
    warn_loose_files: z.boolean(),
    /**
     * Subfolders inside a season folder. The scanner expects a flat episode
     * layout. Files in subfolders are silently dropped without this warning.
     */
    warn_extra_subfolders: z.boolean(),
    /**
     * Files that aren't video, aren't recognized Plex sidecars, and aren't
     * known OS artifacts. Catches stray files silently ignored elsewhere.
     */
    warn_unexpected_entries: z.boolean(),
    /**
     * TMDB found no plausible match for the local title + year. Surfaced
     * from the validate pass (validation-warnings.json).
     */
    warn_tmdb_no_match: z.boolean(),
    /**
     * TMDB match had low confidence — title close but not exact, or year
     * disagrees. Worth reviewing.
     */
    warn_tmdb_low_confidence: z.boolean(),
    /**
     * Local season has a different episode count than TMDB reports. Catches
     * incomplete seasons even when episode numbers don't have gaps (e.g.
     * you have 1-10 but TMDB says the season has 13). Per-season warning.
     */
    warn_tmdb_episode_count: z.boolean(),
    /**
     * TMDB matched but the folder title isn't byte-for-byte equal to TMDB's
     * filename-safe canonical title (case-sensitive). Same idea as the
     * movies rule — surfaces case/accent/capitalization opportunities.
     */
    warn_tmdb_title_canonical: z.boolean(),
    /**
     * Files that match the Plex naming convention but omit the trailing
     * episode title (e.g. `Show (2020) - S01E03.mp4`). Surfaced once per
     * season as a summary so the warnings list isn't drowned in per-file
     * noise. Default-on but easy to silence for libraries that don't care
     * about titling.
     */
    warn_missing_episode_title: z.boolean(),
    /**
     * Per-episode title comparison against TMDB. Strict match — local title
     * must equal TMDB's title for that episode after filename-safe
     * normalization. Only fires for single-episode files when
     * `warn_tmdb_episode_name_multi_episode` is false (the default); see
     * that toggle for multi-episode (S01E01-E02) handling.
     */
    warn_tmdb_episode_name_mismatch: z.boolean(),
    /**
     * When true, the per-episode TMDB title check also fires for multi-
     * episode files (e.g. `S01E01-E02 - Broken Bow Part 1 And 2`). The
     * filename's title is considered a match if it equals ANY of the
     * constituent episodes' TMDB titles (since the local title typically
     * combines several). Default false because combined titles rarely
     * match strictly and the resulting warnings are usually noise.
     */
    warn_tmdb_episode_name_multi_episode: z.boolean(),
  }),
})

export type ShowsRules = z.infer<typeof ShowsRulesSchema>

export const defaultShowsRules: ShowsRules = ShowsRulesSchema.parse({
  patterns: {
    show_folder: '^(?<title>.+)\\s\\((?<year>\\d{4})\\)(?:\\s\\{edition-(?<edition>[^}]*)\\})?$',
    season_folder: { pattern: '^Season\\s(?<season>\\d{2})$', flags: 'i' },
    file: {
      pattern:
        '^(?<title>.+)\\s\\((?<year>\\d{4})\\)\\s-\\sS(?<season>\\d{2})E(?<episode>\\d{2,3})(?:-E?(?<episode_end>\\d{2,3}))?(?:\\s-\\s(?<episode_title>.+))?$',
      flags: 'i',
    },
  },
  categories: [],
  primary_extension: ['.mp4'],
  video_extensions: ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts'],
  ignored_season_names: ['Specials'],
  // Neutral: no house style, so no warnings. Libraries pick one in
  // shows.local.yaml.
  episode_code_case: 'any',
  sidecar_extensions: [
    '.nfo',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.tbn',
    '.srt',
    '.ass',
    '.ssa',
    '.vtt',
    '.sub',
    '.idx',
  ],
  quality_thresholds: [],
  // Neutral default mirroring movies: a UHD master + HD downscale of the same
  // season is commonly intentional. Libraries can clear or extend this in
  // shows.local.yaml.
  acceptable_quality_combos: [['UHD', 'HD']],
  checks: {
    warn_non_primary: true,
    warn_no_videos: true,
    warn_bad_show_folder: true,
    warn_empty_edition: true,
    warn_bad_season_folder: true,
    warn_bad_file_name: true,
    warn_show_year_mismatch: true,
    warn_show_title_case: true,
    warn_episode_code_case: true,
    warn_season_mismatch: true,
    warn_episode_gaps: true,
    warn_quality_mismatch: true,
    warn_duplicate_quality: true,
    warn_multi_quality: true,
    warn_loose_files: true,
    warn_extra_subfolders: true,
    warn_unexpected_entries: true,
    warn_tmdb_no_match: true,
    warn_tmdb_low_confidence: true,
    warn_tmdb_episode_count: true,
    warn_tmdb_title_canonical: true,
    warn_missing_episode_title: true,
    warn_tmdb_episode_name_mismatch: true,
    warn_tmdb_episode_name_multi_episode: false,
  },
})
