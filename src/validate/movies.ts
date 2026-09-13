/**
 * validate/movies.ts
 * ------------------
 * Per-movie TMDB validation. For each movie in the scan output:
 *   1. Look up the search cache. On miss, call TMDB /search/movie.
 *   2. Pick the best candidate using title + year matching with confidence
 *      scoring. Save the resolution back to the search cache.
 *   3. If a match was found, look up (or fetch + cache) movie details for
 *      the canonical title/year/runtime.
 *   4. Emit warnings for low-confidence matches so the user can review.
 *
 * The aggregated MovieValidation[] is what gets written to
 * output/movies/validation.json. Warnings go to validation-warnings.json
 * via the shared WarningCollector.
 */

import { MovieOutput, WarningCollector } from '../core/types'
import { MoviesRules } from '../core/rules/movies'

import { JsonCache, searchKey } from './cache'
import {
  categoriesOf,
  normalizeTitle,
  normalizeTitleLoose,
  parseYear,
  stripFilenameIllegalChars,
} from './helpers'
import { TmdbClient } from './tmdb'
import { MovieValidation, ResolvedSearch, TmdbMovieDetails, TmdbMovieSearchResult } from './types'

// ─────────────────────────────────────────────
// Match scoring
// ─────────────────────────────────────────────

/**
 * Score the best TMDB candidate against the local title + year and assign
 * a confidence bucket.
 *
 * ── Scoring components ─────────────────────────
 * Title match (one of, in priority order):
 *   100  exact match on either `title` or `original_title` after strict
 *        normalization (see `normalizeTitle`)
 *    90  exact match under the LOOSE normalization (see `normalizeTitleLoose`) —
 *        bridges the ways a filename-illegal character gets rendered in a folder
 *        name: "Ghostbusters - Afterlife" vs TMDB's "Ghostbusters: Afterlife",
 *        "Pain And Gain" vs "Pain & Gain", "Good Morning Vietnam" vs
 *        "Good Morning, Vietnam". Weighted so a loose hit always outranks a
 *        prefix hit (60 + 50 = 110) but never beats a strict one.
 *    60  one side is a prefix of the other followed by a space (handles missing
 *        subtitles like "Star Wars" vs "Star Wars: A New Hope")
 *    30  substring containment in either direction (last-resort fuzzy)
 *
 * Year match:
 *    50  exact
 *    30  off by 1 (US vs international release dates often differ by a year)
 *    15  off by 2
 *   -20  off by more (strong penalty — wrong year usually means wrong film)
 *
 * ── Confidence thresholds ──────────────────────
 *   high   ≥ 150  → only achievable as 100 (title exact) + 50 (year exact).
 *                   Locks in cases where both fields agree.
 *   medium ≥ 110  → 100 + 30 (title exact, year off by 1),
 *                   90 + 50 (loose title match, year exact — matched, but not
 *                   byte-identical) or 60 + 50 (prefix match, year exact).
 *   low    ≥ 60   → anything else with at least a partial title match.
 *   none   < 60   → no plausible candidate; we drop the ID entirely so the
 *                   warning isn't misleading.
 *
 * The popularity sort below means: when two candidates tie on score (very
 * common with generic titles like "Heat" or "It"), we pick the more famous
 * one — which is almost always what the user has.
 */
function pickBestMovieMatch(
  localTitle: string,
  localYear: number,
  candidates: TmdbMovieSearchResult[]
): ResolvedSearch {
  if (candidates.length === 0) {
    return { best_id: null, confidence: 'none', candidates: [] }
  }

  const ourTitle = normalizeTitle(localTitle)
  const ourLooseTitle = normalizeTitleLoose(localTitle)
  let bestScore = 0
  let bestId: number | null = null
  const candidateIds: number[] = []

  // Sort by popularity descending so that score ties resolve to the better-
  // known film. TMDB's `popularity` is updated nightly from view counts +
  // search frequency, so it's a decent proxy for "the one most users mean".
  const sorted = [...candidates].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))

  // Keep only the top 5 candidate IDs for the output's `alternatives` list —
  // anything beyond the top 5 is rarely worth showing the user.
  for (const c of sorted.slice(0, 5)) candidateIds.push(c.id)

  for (const c of sorted) {
    const theirTitle = normalizeTitle(c.title)
    const theirOrigTitle = normalizeTitle(c.original_title)
    const theirYear = parseYear(c.release_date)
    const yearDelta = theirYear === null ? 99 : Math.abs(theirYear - localYear)

    let score = 0

    // Title match — try both `title` (localized) and `original_title` (native).
    // Foreign films often hit on `original_title` when the user kept the
    // native name (e.g. "Amélie" vs the English-localized version).
    if (theirTitle === ourTitle || theirOrigTitle === ourTitle) {
      score += 100
    } else if (
      normalizeTitleLoose(c.title) === ourLooseTitle ||
      normalizeTitleLoose(c.original_title) === ourLooseTitle
    ) {
      score += 90
    } else if (theirTitle.startsWith(ourTitle + ' ') || ourTitle.startsWith(theirTitle + ' ')) {
      score += 60
    } else if (theirTitle.includes(ourTitle) || ourTitle.includes(theirTitle)) {
      score += 30
    }

    // Year match. The off-by-1 case is by far the most common after exact —
    // TMDB uses the original-release year, which often differs from the wide-
    // release year a user gets their copy from. Casablanca (1942 premiere /
    // 1943 wide), 300 (2006 premiere / 2007 wide), etc.
    if (yearDelta === 0) score += 50
    else if (yearDelta === 1) score += 30
    else if (yearDelta === 2) score += 15
    else score -= 20

    if (score > bestScore) {
      bestScore = score
      bestId = c.id
    }
  }

  let confidence: ResolvedSearch['confidence']
  if (bestScore >= 150) confidence = 'high'
  else if (bestScore >= 110) confidence = 'medium'
  else if (bestScore >= 60) confidence = 'low'
  else confidence = 'none'

  // Drop the ID for `none` so consumers don't accidentally treat a low-score
  // best guess as a real match. The candidate list is still preserved for
  // the alternatives section of the warning.
  if (confidence === 'none') bestId = null
  return { best_id: bestId, confidence, candidates: candidateIds }
}

// ─────────────────────────────────────────────
// Local runtime comparison
// ─────────────────────────────────────────────

/** One probed file's measured runtime, keyed into `MovieDurations` by movie. */
export interface MovieFileDuration {
  /** Library-relative path, used as the warning path. */
  path: string
  duration_seconds: number
}

/** Map from `movieDurationKey()` to every probed file for that movie. */
export type MovieDurations = Map<string, MovieFileDuration[]>

/**
 * Join key between the scan catalog and the probe output. Mirrors `makeKey`
 * in probe/movies.ts — title|year|edition, lowercased.
 */
export function movieDurationKey(title: string, year: number, edition: string | null): string {
  return `${title.toLowerCase()}|${year}|${(edition ?? '').toLowerCase()}`
}

/** Format a minute count for warning text — `5m`, `1h 47m`. */
function formatMinutes(minutes: number): string {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ─────────────────────────────────────────────
// Validation entry point
// ─────────────────────────────────────────────

export async function validateMovies(
  movies: MovieOutput[],
  rules: MoviesRules,
  client: TmdbClient,
  searchCache: JsonCache<ResolvedSearch>,
  detailsCache: JsonCache<TmdbMovieDetails>,
  warnings: WarningCollector,
  /**
   * Measured runtimes from the probe pass, for `warn_tmdb_runtime_mismatch`.
   * Omitted (or empty) simply skips that check — the rest of validation does
   * not depend on probe output.
   */
  durations?: MovieDurations,
  onProgress?: (done: number, total: number, cached: number) => void
): Promise<MovieValidation[]> {
  const out: MovieValidation[] = []
  let cachedCount = 0

  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i]!
    const sKey = searchKey('movie', movie.title, movie.year)

    // A cached verdict that produced a warning is never final. TMDB's search
    // index changes over time — "Face/Off" simply wasn't returned for the query
    // "FaceOff" when this library was first validated, and stayed a permanent
    // false no-match because nothing ever re-asked. Confident matches stay
    // cached, so warm runs are still fast; only the warning set is re-queried.
    const cached = searchCache.get(sKey)
    let resolved: ResolvedSearch | undefined =
      cached && cached.confidence !== 'none' && cached.confidence !== 'low' ? cached : undefined
    if (resolved) {
      cachedCount++
    } else {
      try {
        const candidates = await client.searchMovie(movie.title, movie.year)
        resolved = pickBestMovieMatch(movie.title, movie.year, candidates)
        searchCache.set(sKey, resolved)
      } catch (err) {
        console.error(
          `    [TMDB] Search failed for ${movie.title} (${movie.year}): ${(err as Error).message}`
        )
        resolved = { best_id: null, confidence: 'none', candidates: [] }
      }
    }

    const entry: MovieValidation = {
      title: movie.title,
      year: movie.year,
      edition: movie.edition,
      confidence: resolved.confidence,
      tmdb_id: resolved.best_id,
      tmdb_title: null,
      tmdb_title_filename_safe: null,
      tmdb_year: null,
      alternatives: [],
    }

    // Pull canonical details for the best match
    let tmdbRuntime: number | null = null
    if (resolved.best_id !== null) {
      let details = detailsCache.get(String(resolved.best_id))
      if (!details) {
        try {
          details = await client.getMovie(resolved.best_id)
          detailsCache.set(String(resolved.best_id), details)
        } catch (err) {
          console.error(
            `    [TMDB] Details failed for id=${resolved.best_id}: ${(err as Error).message}`
          )
        }
      }
      if (details) {
        entry.tmdb_title = details.title
        entry.tmdb_title_filename_safe = stripFilenameIllegalChars(details.title)
        entry.tmdb_year = parseYear(details.release_date)
        // TMDB reports 0 for records where nobody has filled the runtime in —
        // treat that as "unknown" rather than a zero-length film.
        tmdbRuntime = details.runtime ? details.runtime : null
      }
    }

    // Pull alternates (other candidates) for review
    for (const altId of resolved.candidates) {
      if (altId === resolved.best_id) continue
      const altDetails = detailsCache.get(String(altId))
      if (altDetails) {
        entry.alternatives.push({
          id: altId,
          title: altDetails.title,
          year: parseYear(altDetails.release_date),
        })
      }
    }

    // Emit warnings according to confidence. Path is prefixed with the
    // movie's first category so flat-library and quality-organized users
    // both get a clickable, copy-pasteable folder path. "default" is the
    // sentinel for an empty `categories` config — skip the prefix there.
    const movieLabel = movie.edition
      ? `${movie.title} (${movie.year}) {edition-${movie.edition}}`
      : `${movie.title} (${movie.year})`
    const firstCategory = movie.versions[0]?.category
    const moviePath =
      firstCategory && firstCategory !== 'default' ? `${firstCategory}/${movieLabel}` : movieLabel

    // The displayed path names only the first category, but a movie can sit in
    // several. Give the ignore matcher all of them so a `folders:` entry isn't
    // at the mercy of which category happened to sort first.
    const movieScope = { categories: categoriesOf(movie.versions), levels: [movieLabel] }

    if (resolved.confidence === 'none' && rules.checks.warn_tmdb_no_match) {
      warnings.add(
        'warn_tmdb_no_match',
        moviePath,
        `TMDB found no match for '${movie.title}' (${movie.year}). Possible typo in title or year, or this movie isn't in TMDB.`,
        { scope: movieScope }
      )
    } else if (resolved.confidence === 'low' && rules.checks.warn_tmdb_low_confidence) {
      const altText =
        entry.alternatives.length > 0
          ? ` Alternatives: ${entry.alternatives.map(a => `'${a.title}' (${a.year})`).join(', ')}.`
          : ''
      warnings.add(
        'warn_tmdb_low_confidence',
        moviePath,
        `TMDB low-confidence match: best guess is '${entry.tmdb_title}' (${entry.tmdb_year}).${altText} Review and confirm.`,
        { scope: movieScope }
      )
    } else if (
      rules.checks.warn_tmdb_year_mismatch &&
      entry.tmdb_year !== null &&
      entry.tmdb_year !== movie.year
    ) {
      warnings.add(
        'warn_tmdb_year_mismatch',
        moviePath,
        `TMDB year mismatch: folder says ${movie.year} but TMDB says '${entry.tmdb_title}' was released in ${entry.tmdb_year}. Verify which is correct.`,
        { scope: movieScope }
      )
    }

    // Canonical title check — only fires when a match was made and the local
    // folder title differs (byte-for-byte) from TMDB's filename-safe form.
    if (
      rules.checks.warn_tmdb_title_canonical &&
      entry.tmdb_title_filename_safe !== null &&
      entry.tmdb_title_filename_safe !== movie.title
    ) {
      warnings.add(
        'warn_tmdb_title_canonical',
        moviePath,
        `TMDB canonical title differs: folder is '${movie.title}', TMDB filename-safe form is '${entry.tmdb_title_filename_safe}'. Consider renaming the folder to match.`,
        { scope: movieScope }
      )
    }

    // Runtime cross-check — the precise counterpart to warn_short_duration.
    // Per-file rather than per-movie: one version of a movie can be truncated
    // while its other versions are fine.
    if (
      rules.checks.warn_tmdb_runtime_mismatch &&
      rules.runtime_tolerance_percent > 0 &&
      tmdbRuntime !== null
    ) {
      const tolerance = rules.runtime_tolerance_percent / 100
      const files = durations?.get(movieDurationKey(movie.title, movie.year, movie.edition)) ?? []
      for (const file of files) {
        const localMinutes = file.duration_seconds / 60
        const drift = Math.abs(localMinutes - tmdbRuntime) / tmdbRuntime
        if (drift <= tolerance) continue
        const direction = localMinutes < tmdbRuntime ? 'shorter' : 'longer'
        const advice =
          direction === 'shorter'
            ? `Usually a truncated or failed encode — play the file to the end and re-encode from source if it's cut short.`
            : `Usually a wrongly-matched film, two features concatenated into one file, or an extended cut TMDB doesn't carry.`
        warnings.add(
          'warn_tmdb_runtime_mismatch',
          file.path,
          `TMDB runtime mismatch — file is ${formatMinutes(localMinutes)} but TMDB says ` +
            `'${entry.tmdb_title}' runs ${formatMinutes(tmdbRuntime)} ` +
            `(${Math.round(drift * 100)}% ${direction}, tolerance is ${rules.runtime_tolerance_percent}%). ` +
            `${advice} If the difference is intentional, silence it in ignored/<drive>/movies.yaml ` +
            `under 'files:' (note that silences the file's other warnings too), or turn the ` +
            `check off entirely with checks.warn_tmdb_runtime_mismatch: false`
        )
      }
    }

    out.push(entry)
    onProgress?.(i + 1, movies.length, cachedCount)
  }

  return out
}
