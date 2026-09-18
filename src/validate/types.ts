/**
 * validate/types.ts
 * -----------------
 * Shared types for the TMDB validation layer.
 *
 * Three groupings:
 *   1. Raw TMDB API response shapes (only the fields we read)
 *   2. Cached entity shapes (what lives in cache/tmdb-*.json)
 *   3. Validation output shapes (per-record results written to validation.json)
 */

// ─────────────────────────────────────────────
// Raw TMDB shapes (subset of fields we use)
// ─────────────────────────────────────────────

/** One result from `/search/movie`. */
export interface TmdbMovieSearchResult {
  id: number
  title: string
  original_title: string
  release_date?: string // "YYYY-MM-DD"
  popularity?: number
  vote_count?: number
}

/** Full movie record from `/movie/<id>`. */
export interface TmdbMovieDetails {
  id: number
  title: string
  original_title: string
  release_date?: string
  runtime?: number | null
  overview?: string
  genres?: Array<{ id: number; name: string }>
}

/** One result from `/search/tv`. */
export interface TmdbShowSearchResult {
  id: number
  name: string
  original_name: string
  first_air_date?: string
  popularity?: number
  vote_count?: number
}

/** One season summary nested inside a TV show details response. */
export interface TmdbShowSeasonSummary {
  season_number: number
  episode_count: number
  name: string
  air_date?: string
}

/** Full show record from `/tv/<id>`. */
export interface TmdbShowDetails {
  id: number
  name: string
  original_name: string
  first_air_date?: string
  number_of_seasons: number
  number_of_episodes: number
  seasons: TmdbShowSeasonSummary[]
  genres?: Array<{ id: number; name: string }>
}

/** One episode summary inside a season details response. */
export interface TmdbEpisodeSummary {
  episode_number: number
  name: string
  air_date?: string
}

/** Full season record from `/tv/<id>/season/<n>`. */
export interface TmdbSeasonDetails {
  /** TMDB's own ID for this season (rarely needed). */
  id?: number
  season_number: number
  name?: string
  episodes: TmdbEpisodeSummary[]
}

// ─────────────────────────────────────────────
// Cache shapes
// ─────────────────────────────────────────────

/**
 * Lookup key shape for the search cache. Stored as a string in the cache
 * (`<type>|<title-lower>|<year>`) but tracked here for documentation.
 */
export interface SearchKey {
  type: 'movie' | 'show'
  title: string
  year: number
}

/** Result of a search resolved to (best) TMDB ID + alternate candidates. */
export interface ResolvedSearch {
  /** Picked TMDB ID, or null when no acceptable match. */
  best_id: number | null
  /** How confident we were in the pick. */
  confidence: 'high' | 'medium' | 'low' | 'none'
  /**
   * All candidate IDs returned (up to a small cap) so a user reviewing
   * `needs_review` warnings can see what we considered.
   */
  candidates: number[]
}

/**
 * Wrapped cache entry. `fetched_at` is an ISO 8601 UTC timestamp captured at
 * `set()` time; the runner uses it to expire stale entries.
 */
export interface TimestampedEntry<T> {
  value: T
  fetched_at: string
}

/** Cache file shape — schema-versioned. */
export interface ValidationCacheFile<T> {
  version: number
  entries: Record<string, TimestampedEntry<T>>
}

/**
 * Default version for entity-detail caches (movies, shows, show-seasons).
 *
 *   v1: untimestamped entries — `Record<string, T>`
 *   v2: timestamped entries — `Record<string, {value: T, fetched_at: string}>`
 */
export const CACHE_VERSION = 2

// ─────────────────────────────────────────────
// Validation output shapes
// ─────────────────────────────────────────────

/**
 * Per-movie validation result, joinable to scan output's movies.json by
 * (title, year, edition). One entry per scanned movie regardless of
 * whether TMDB matched.
 */
export interface MovieValidation {
  /** From the scan — used as the join key. */
  title: string
  year: number
  edition: string | null
  /** Match confidence — see ResolvedSearch.confidence. */
  confidence: 'high' | 'medium' | 'low' | 'none'
  /** TMDB ID when matched, null otherwise. */
  tmdb_id: number | null
  /** Canonical title from TMDB (often differs in capitalization/punctuation). */
  tmdb_title: string | null
  /**
   * TMDB title with Windows-illegal filename characters (`< > : " | ? * \ /`)
   * stripped without replacement. Use this as the rename target if you want
   * your folder name to match TMDB. `null` when no TMDB match.
   *
   *   "50/50"            → "5050"
   *   "3:10 to Yuma"     → "310 to Yuma"
   *   "M*A*S*H"          → "MASH"
   *   "Amélie"           → "Amélie"  (accent stays — accents are legal in filenames)
   */
  tmdb_title_filename_safe: string | null
  /** Canonical release year from TMDB. */
  tmdb_year: number | null
  /** Other candidate matches when our pick was uncertain. */
  alternatives: Array<{ id: number; title: string; year: number | null }>
}

/** Per-season validation result for a show. */
export interface SeasonValidation {
  /** Season label from scan (e.g. "1", "Specials"). */
  season: string
  /** Episodes you have for this season (from the scan). */
  local_episode_count: number
  /** Episodes TMDB reports for this season, or null if season not in TMDB. */
  tmdb_episode_count: number | null
  /** Difference: positive = you're missing, negative = you have extras. */
  missing: number | null
}

/** Per-show validation result, joinable to scan output's shows.json. */
export interface ShowValidation {
  title: string
  year: number
  /**
   * Plex's TV Show Editions tag, or null when untagged. Carried so the row
   * joins back to a specific show folder on disk — `fix:shows` keys on the
   * folder name, and two editions share one title+year.
   */
  edition: string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  tmdb_id: number | null
  tmdb_title: string | null
  /** See MovieValidation.tmdb_title_filename_safe. */
  tmdb_title_filename_safe: string | null
  tmdb_first_air_year: number | null
  alternatives: Array<{ id: number; title: string; year: number | null }>
  seasons: SeasonValidation[]
}

// ─────────────────────────────────────────────
// Cache versioning
// ─────────────────────────────────────────────

/**
 * Search-cache version. Bumped when scoring/normalization changes so that
 * previously-resolved "none" entries get re-evaluated against the new logic.
 *
 *   v1: initial scoring (case-insensitive, strip all punctuation as space)
 *   v2: filename-safe normalization (strip only filename-illegal chars,
 *       fold diacritics)
 *   v3: timestamped entries (every cache file gained `fetched_at` for TTL)
 *   v4: search fall-back without year-filter on empty year-filtered result —
 *       fixes false `warn_tmdb_no_match` on films whose folder year differs
 *       from TMDB's primary_release_date year (web-series origin, bundled
 *       re-releases, etc.)
 *
 * NOT bumped for the loose-normalization tier (`normalizeTitleLoose`), because
 * the validators stopped trusting cached `none` / `low` verdicts at the same
 * time — every entry the new tier could change is re-queried on the next run
 * anyway. A bump would have discarded ~4,900 good `high` entries to re-resolve
 * the ~600 that mattered. Bump this if a future change can alter a `high` or
 * `medium` verdict, which nothing re-queries.
 */
export const SEARCH_CACHE_VERSION = 4
