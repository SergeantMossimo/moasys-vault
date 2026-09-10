/**
 * core/rules/movies.ts
 * --------------------
 * Schema, defaults, and inferred type for the Movies rules layer.
 *
 * Rules describe the *conventions* of a Plex movie library — what folder
 * and file names look like, what year range is plausible, which cross-folder
 * quality combos are intentional, and which warnings the user wants to see.
 *
 * Code-shipped defaults below mirror the original hardcoded constants and
 * regex from src/media/movies.ts so that running with no rules/movies.yaml
 * file behaves identically to the pre-refactor scanner.
 */

import { z } from 'zod'

import { PatternSchema, CategorySchema } from './helpers'

export const MoviesRulesSchema = z.object({
  /** Regex patterns for folder and file names. Must use named capture groups. */
  patterns: z.object({
    /** Captures: title, year */
    folder: PatternSchema,
    /** Captures: title, year, edition (optional) */
    file: PatternSchema,
  }),

  /**
   * Subfolders under root_path to walk. Each category's name appears as the
   * `category` field on every version that lives in that subfolder. Empty
   * (or omitted) means the scanner walks root_path itself and labels records
   * with "default" — useful for flat libraries without quality buckets.
   */
  categories: z.array(CategorySchema),

  /**
   * Expected primary file format(s) for movies in this library. Files with
   * a non-primary extension are flagged with `warn_non_primary`. Lossless
   * libraries might set this to [".mkv"]; Apple-friendly libraries [".mp4"].
   */
  primary_extension: z.array(z.string()).min(1),

  /**
   * All file extensions the scanner recognizes as video files. Anything
   * outside this list is treated as either a sidecar (if its extension is
   * in `sidecar_extensions`) or an "unexpected entry". Includes the primary
   * formats plus any other formats that might appear.
   */
  video_extensions: z.array(z.string()).min(1),

  /**
   * Acceptable year range for a film.
   * `max: "current"` is replaced with the current year at load time so
   * the runtime always sees `max: number`.
   */
  year_range: z.object({
    min: z.number().int().positive(),
    max: z.union([z.number().int().positive(), z.literal('current')]),
  }),

  /**
   * Cross-folder quality combos that are intentional and should NOT trigger
   * the "movie exists in multiple quality folders" warning.
   * Comparison is set-based — order inside each combo doesn't matter.
   *
   * Silences `warn_multi_quality` only. A combo lists which quality TIERS may
   * coexist, so it can never silence `warn_duplicate_quality` — a movie in
   * `HD/` + `Other HD/` + `UHD/` still resolves to the tier set {UHD, HD} and
   * matches `[UHD, HD]`, but the two HD-tier copies are reported regardless.
   */
  acceptable_quality_combos: z.array(z.array(z.string())),

  /**
   * File extensions for Plex sidecar files (NFO metadata, posters,
   * subtitles, etc.). Files with these extensions are silently allowed
   * anywhere in the movie hierarchy and never flagged as "unexpected".
   * Override if your library uses additional sidecar formats.
   */
  sidecar_extensions: z.array(z.string()),

  /**
   * Quality buckets for ffprobe-driven validation. Each bucket's `name`
   * matches a category name — a file in a category named "UHD" is checked
   * against the bucket named "UHD". The pixel-width range applies to the
   * file's long edge (max of width, height) so HandBrake-cropped or rotated
   * files still classify correctly.
   *
   * Categories that don't have a matching bucket (e.g. "Other UHD" when no
   * bucket of that name exists) are silently passed. This is intentional —
   * the warning is opt-in by bucket configuration.
   *
   * Empty by default — libraries with custom folder structures don't get
   * bogus warnings until they configure their own buckets.
   */
  quality_thresholds: z.array(
    z.object({
      name: z.string(), // Must match a category name to take effect
      min_width: z.number().int().positive().optional(),
      max_width: z.number().int().positive().optional(),
    })
  ),

  /** Per-warning toggles. Set any to false to silence that warning. */
  checks: z.object({
    warn_non_primary: z.boolean(),
    warn_no_videos: z.boolean(),
    warn_bad_file_name: z.boolean(),
    warn_bad_folder_name: z.boolean(),
    warn_empty_edition: z.boolean(),
    warn_suspicious_year: z.boolean(),
    warn_title_mismatch: z.boolean(),
    /**
     * The file title matches its folder except for capitalization. Split out
     * from `warn_title_mismatch`, which lowercases both sides and so cannot
     * see this at all — see the matching note on shows' warn_show_title_case.
     */
    warn_title_case: z.boolean(),
    warn_year_mismatch: z.boolean(),
    warn_duplicate_edition: z.boolean(),
    /**
     * The same movie exists in two or more category folders that resolve to
     * the SAME quality tier (e.g. `HD/` and `Other HD/`) — redundant copies
     * of the same thing. Deliberately NOT silenceable via
     * `acceptable_quality_combos`: those describe which tiers may coexist,
     * not how many copies may sit inside one tier.
     */
    warn_duplicate_quality: z.boolean(),
    warn_multi_quality: z.boolean(),
    warn_quality_mismatch: z.boolean(),
    /**
     * Video files found at a level where the scanner expects a subfolder.
     * Specifically: video files placed directly in a media folder rather
     * than inside a Movie Title (YEAR) folder. Files there are silently
     * dropped from the catalog without this warning enabled.
     */
    warn_loose_files: z.boolean(),
    /**
     * Subfolders inside a movie folder. The scanner does not recurse, so
     * video files in subfolders are silently dropped without this warning.
     */
    warn_extra_subfolders: z.boolean(),
    /**
     * Files that aren't video, aren't recognized Plex sidecars, and aren't
     * known OS artifacts (Thumbs.db, .DS_Store, etc.). Catches stray .zip,
     * .txt, .m3u files etc. that are silently ignored without this check.
     */
    warn_unexpected_entries: z.boolean(),
    /**
     * TMDB found no plausible match for the local title + year. Possible
     * typo, obscure film not in TMDB, or wrong year. Surfaced from the
     * validate pass (validation-warnings.json).
     */
    warn_tmdb_no_match: z.boolean(),
    /**
     * TMDB returned a match but our scoring rated the confidence as "low"
     * — title is close but not exact, OR year disagrees. Worth reviewing.
     */
    warn_tmdb_low_confidence: z.boolean(),
    /**
     * TMDB confidently matched the title but the canonical year on TMDB
     * differs from the local year. Possible folder/file year is wrong.
     */
    warn_tmdb_year_mismatch: z.boolean(),
    /**
     * TMDB matched but the folder title isn't byte-for-byte equal to TMDB's
     * filename-safe canonical title (case-sensitive). Catches missing
     * accents on legal characters, capitalization differences, etc. — cases
     * where you COULD rename to match TMDB exactly.
     */
    warn_tmdb_title_canonical: z.boolean(),
  }),
})

export type MoviesRules = z.infer<typeof MoviesRulesSchema>

// Defaults use the string form of patterns since none need flags — Zod's
// preprocess normalizes them to { pattern, flags: '' } at validation time.
export const defaultMoviesRules: MoviesRules = MoviesRulesSchema.parse({
  patterns: {
    folder: '^(?<title>.+)\\s\\((?<year>\\d{4})\\)$',
    file: '^(?<title>.+)\\s\\((?<year>\\d{4})\\)(?:\\s\\{edition-(?<edition>[^}]*)\\})?$',
  },
  categories: [],
  primary_extension: ['.mp4'],
  video_extensions: ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.webm'],
  year_range: {
    min: 1888, // Roundhay Garden Scene
    max: 'current',
  },
  // Neutral default: a single canonical UHD↔HD pairing that's commonly
  // intentional (a 4K master + a 1080p downscale for playback compatibility).
  // Libraries with custom quality folders (e.g. "Other UHD", "Other HD") add
  // their own combos via rules/movies.local.yaml.
  acceptable_quality_combos: [['UHD', 'HD']],
  // Plex sidecar formats — metadata (.nfo), artwork (.jpg/.png/.webp/.tbn),
  // subtitles (.srt/.ass/.ssa/.vtt/.sub/.idx). Silently allowed everywhere.
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
  quality_thresholds: [], // Ships empty — see rules/movies.example.yaml for the shape
  checks: {
    warn_non_primary: true,
    warn_no_videos: true,
    warn_bad_file_name: true,
    warn_bad_folder_name: true,
    warn_empty_edition: true,
    warn_suspicious_year: true,
    warn_title_mismatch: true,
    warn_title_case: true,
    warn_year_mismatch: true,
    warn_duplicate_edition: true,
    warn_duplicate_quality: true,
    warn_multi_quality: true,
    warn_quality_mismatch: true,
    warn_loose_files: true,
    warn_extra_subfolders: true,
    warn_unexpected_entries: true,
    warn_tmdb_no_match: true,
    warn_tmdb_low_confidence: true,
    warn_tmdb_year_mismatch: true,
    warn_tmdb_title_canonical: true,
  },
})
