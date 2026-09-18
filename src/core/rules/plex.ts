/**
 * core/rules/plex.ts
 * ------------------
 * Schema, defaults, and inferred type for the Plex rules layer
 * (`rules/plex.yaml` + `rules/plex.local.yaml`).
 *
 * One rules file for every media type: the Plex checks compare Plex's view
 * of a library with the scanner's, and the comparison is the same whether
 * the library holds movies or audiobooks. Warnings still land per type and
 * drive, in output/<drive>/<type>/plex-warnings.json.
 */

import { z } from 'zod'

export const PlexRulesSchema = z.object({
  /** Per-warning toggles. */
  checks: z.object({
    /**
     * Files on disk inside a folder no Plex library covers — Plex will never
     * scan them. Reported once at the shallowest such folder.
     */
    warn_plex_folder_not_in_library: z.boolean(),
    /** A file the scan found on disk that no Plex item points at — Plex never picked it up. */
    warn_plex_missing_item: z.boolean(),
    /** A file Plex points at that no longer exists on disk, and that Plex hasn't noticed is gone. */
    warn_plex_orphan_item: z.boolean(),
    /** A file Plex has flagged deleted — it's sitting in the library's trash. */
    warn_plex_unavailable: z.boolean(),
    /** A movie, show, or album Plex couldn't match to its metadata agent. */
    warn_plex_unmatched: z.boolean(),
    /**
     * Plex's title or year for a movie/show names something different from
     * its folder — usually a wrong match. Year differences of one are
     * ignored (premiere vs wide release); the TMDB pass covers those.
     */
    warn_plex_title_mismatch: z.boolean(),
    /** Plex's title matches the folder except for capitalization. */
    warn_plex_title_case: z.boolean(),
    /**
     * Plex's edition name for a show disagrees with the `{edition-…}` tag on
     * its folder — including one side carrying an edition and the other not.
     * Shows only: a movie's edition tag lives in the filename, not the folder,
     * so there is nothing on the folder to compare it against.
     */
    warn_plex_edition_mismatch: z.boolean(),
    /** Plex's edition name matches the folder's tag except for capitalization. */
    warn_plex_edition_case: z.boolean(),
    /** An item Plex lists under its Duplicates filter — several files merged into one entry. */
    warn_plex_duplicate: z.boolean(),
    /** `plex:logs` — ERROR lines in Plex's server or scanner logs about a file or folder. */
    warn_plex_log_error: z.boolean(),
    /**
     * `plex:logs` — WARN lines about a file or folder. Off by default: they're
     * mostly FFmpeg muxing notes (`timescale not set`) with nothing to fix.
     */
    warn_plex_log_warning: z.boolean(),
  }),
})

export type PlexRules = z.infer<typeof PlexRulesSchema>

export const defaultPlexRules: PlexRules = PlexRulesSchema.parse({
  checks: {
    warn_plex_folder_not_in_library: true,
    warn_plex_missing_item: true,
    warn_plex_orphan_item: true,
    warn_plex_unavailable: true,
    warn_plex_unmatched: true,
    warn_plex_title_mismatch: true,
    warn_plex_title_case: true,
    warn_plex_edition_mismatch: true,
    warn_plex_edition_case: true,
    warn_plex_duplicate: true,
    warn_plex_log_error: true,
    warn_plex_log_warning: false,
  },
})
