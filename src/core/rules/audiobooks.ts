/**
 * core/rules/audiobooks.ts
 * ------------------------
 * Schema, defaults, and inferred type for the Audiobooks rules layer.
 *
 * Mirrors the previously hardcoded patterns in src/media/audiobooks.ts.
 *
 * Author folder parsing (single author, comma-separated, "and"-joined) lives
 * in code — it's not regex-shaped and exposing it as YAML would be more
 * brittle than helpful. If anyone needs a different author convention later
 * we can add a separator field then.
 */

import { z } from 'zod'

import { PatternSchema, CategorySchema } from './helpers'

export const AudiobooksRulesSchema = z.object({
  /**
   * Regex patterns for chapter file stems.
   *
   * The scanner tries `multi_disc` first (more specific), then `single_disc`.
   * - `single_disc` captures: chapter, name
   * - `multi_disc` captures: disc, chapter, name
   *
   * Single-disc files (e.g. "01 - Chapter Name") are treated as disc 1.
   */
  patterns: z.object({
    single_disc: PatternSchema,
    multi_disc: PatternSchema,
  }),

  /** Subfolders under root_path to walk. Empty = walk root_path directly with "default" label. */
  categories: z.array(CategorySchema),

  /** Expected primary file format(s) for audiobook chapters. */
  primary_extension: z.array(z.string()).min(1),

  /** All file extensions the scanner recognizes as audio files. */
  audio_extensions: z.array(z.string()).min(1),

  /**
   * File extensions for sidecar files (NFO metadata, cover art).
   * Silently allowed anywhere in the audiobooks hierarchy.
   */
  sidecar_extensions: z.array(z.string()),

  /**
   * Category sets in which the same book may legitimately appear without
   * firing `warn_duplicate_book`. Set-based comparison — order doesn't
   * matter. Example: a book kept in both `Audible` and `Book On CD`
   * categories is whitelisted by listing `[Audible, Book On CD]`.
   *
   * Empty default — every cross-category duplicate fires the warning.
   * Most users likely won't need this; included for symmetry with music.
   */
  acceptable_book_combos: z.array(z.array(z.string())),

  /** Per-warning toggles. */
  checks: z.object({
    warn_non_primary: z.boolean(),
    warn_no_audio: z.boolean(),
    warn_bad_chapter_name: z.boolean(),
    warn_chapter_gaps: z.boolean(),
    warn_duplicate_book: z.boolean(),
    /**
     * Audio files found at a level where the scanner expects a subfolder.
     * Examples: files directly in a media folder (no author), or directly
     * in an author folder (no book subfolder). Silently dropped without
     * this warning enabled.
     */
    warn_loose_files: z.boolean(),
    /**
     * Subfolders inside a book folder. The scanner expects a flat chapter
     * layout (multi-disc uses prefix like 101, 201). Files in subfolders
     * are silently dropped without this warning enabled.
     */
    warn_extra_subfolders: z.boolean(),
    /**
     * Files that aren't audio, aren't recognized sidecars, and aren't known
     * OS artifacts. Catches stray files silently ignored elsewhere.
     */
    warn_unexpected_entries: z.boolean(),
    /**
     * The same series written two different ways across books — a typo or
     * plural drift (`Gaunt's Ghost` vs `Gaunt's Ghosts`). The spelling most
     * books use is recommended. See media/audiobook-names.ts.
     */
    warn_series_name_mismatch: z.boolean(),
    /** Capitalization-only drift in a series name or title prefix (`HALO` vs `Halo`). */
    warn_series_name_case: z.boolean(),
    /**
     * The same author written two different ways (`Tobias S. Buckell` vs
     * `Tobias Buckell`, `J.R.R.` vs `J. R. R.`). Plex treats them as two people.
     */
    warn_author_name_mismatch: z.boolean(),
    /** Capitalization-only drift in an author name. */
    warn_author_name_case: z.boolean(),
    /** HTML entities (`&quot;`, `&amp;`) left in a book or author folder name. */
    warn_encoded_characters: z.boolean(),
    /** A folder name using the library's minority quote style (curly vs straight). */
    warn_mixed_punctuation: z.boolean(),
    /**
     * The book's album tag names a different book than its folder. Audible
     * conventions — `(Unabridged)`, `: ` for ` - `, a folder that adds a
     * subtitle — are normalized away first. See probe/audiobook-tags.ts.
     */
    warn_book_tag_mismatch: z.boolean(),
    /** Album tag and book folder differ only in capitalization. */
    warn_book_tag_case: z.boolean(),
    /** The artist tag names different authors than the author folder (order and role suffixes ignored). */
    warn_author_tag_mismatch: z.boolean(),
    /** Artist tag and author folder differ only in capitalization. */
    warn_author_tag_case: z.boolean(),
    /** No chapter in the book carries an album or artist tag. */
    warn_missing_book_tags: z.boolean(),
    /**
     * Validation pass (`npm run validate:audiobooks`): Open Library has no
     * book matching the title and author. Off by default — Open Library's
     * coverage of tie-in fiction is patchy, so this is mostly noise.
     */
    warn_openlibrary_not_found: z.boolean(),
    /**
     * Validation pass: no Open Library title matches, but one by the same
     * author is a typo's distance away. See validate/audiobooks.ts.
     */
    warn_openlibrary_title_mismatch: z.boolean(),
    /**
     * Validation pass: Open Library's title differs only in capitalization.
     * Off by default — Open Library capitalizes inconsistently itself.
     */
    warn_openlibrary_title_case: z.boolean(),
    /**
     * Validation pass: the title matches but none of the folder's authors do.
     * Off by default — the author folder is already compared against its
     * sibling folders (`warn_author_name_mismatch`) and against the embedded
     * artist tag (`warn_author_tag_mismatch`), so a mistyped author produces
     * three findings for one rename. Those two need no network and disagree
     * far less often: Open Library's author lists are its least reliable
     * field, crediting narrators, translators and editors as authors. Same
     * reasoning as `warn_short_duration`, which defers to the precise
     * `warn_tmdb_runtime_mismatch`. `warn_openlibrary_title_mismatch` stays on
     * — nothing else checks the title against an outside source.
     */
    warn_openlibrary_author_mismatch: z.boolean(),
  }),
})

export type AudiobooksRules = z.infer<typeof AudiobooksRulesSchema>

export const defaultAudiobooksRules: AudiobooksRules = AudiobooksRulesSchema.parse({
  patterns: {
    single_disc: '^(?<chapter>\\d{2})\\s-\\s(?<name>.+)$',
    multi_disc: '^(?<disc>\\d+)(?<chapter>\\d{2})\\s-\\s(?<name>.+)$',
  },
  categories: [],
  primary_extension: ['.mp3', '.flac'],
  audio_extensions: ['.m4b', '.mp3', '.aac', '.m4a', '.flac'],
  // Audiobook sidecars — NFO metadata, cover art, cuesheets, PDF booklets.
  sidecar_extensions: ['.nfo', '.jpg', '.jpeg', '.png', '.webp', '.cue', '.pdf'],
  // Empty by default — every cross-category book duplicate fires the warning.
  acceptable_book_combos: [],
  checks: {
    warn_non_primary: true,
    warn_no_audio: true,
    warn_bad_chapter_name: true,
    warn_chapter_gaps: true,
    warn_duplicate_book: true,
    warn_loose_files: true,
    warn_extra_subfolders: true,
    warn_unexpected_entries: true,
    warn_series_name_mismatch: true,
    warn_series_name_case: true,
    warn_author_name_mismatch: true,
    warn_author_name_case: true,
    warn_encoded_characters: true,
    warn_mixed_punctuation: true,
    warn_book_tag_mismatch: true,
    warn_book_tag_case: true,
    warn_author_tag_mismatch: true,
    warn_author_tag_case: true,
    warn_missing_book_tags: true,
    warn_openlibrary_not_found: false,
    warn_openlibrary_title_mismatch: true,
    warn_openlibrary_title_case: false,
    warn_openlibrary_author_mismatch: false,
  },
})
