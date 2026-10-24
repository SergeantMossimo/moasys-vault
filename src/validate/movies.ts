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
 * output/<drive>/movies/data/validation.json. Warnings go to validation-warnings.json
 * via the shared WarningCollector.
 */

import { MovieOutput, WarningCollector } from '../core/types'
import { MoviesRules } from '../core/rules/movies'
import { categoryPath } from '../core/rules/helpers'

import { JsonCache, searchKey } from './cache'
import {
  cachedFetch,
  alternativesOf,
  categoriesOf,
  guessText,
  hasCredits,
  parseYear,
  pickBestMatch,
  resolveSearch,
  stripFilenameIllegalChars,
} from './helpers'
import { TmdbClient } from './tmdb'
import { MovieValidation, ResolvedSearch, TmdbMovieDetails } from './types'

// ─────────────────────────────────────────────
// Local runtime comparison
// ─────────────────────────────────────────────

/** One probed file's measured runtime, keyed into `MovieDurations` by movie. */
interface MovieFileDuration {
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

/**
 * The folder label for a catalog written before `movies.json` carried
 * `folder`: the title, year and tags, which is right unless an edition sits as
 * a file in a shared folder. A re-scan replaces it with the real name.
 */
function legacyFolderLabel(movie: MovieOutput): string {
  let label = `${movie.title} (${movie.year})`
  if (movie.edition) label += ` {edition-${movie.edition}}`
  if (movie.tmdb_id !== null) label += ` {tmdb-${movie.tmdb_id}}`
  return label
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

/**
 * Validate every movie in a scan catalog against TMDB — see the file header
 * for the steps. Returns one entry per movie for data/validation.json; a
 * movie TMDB couldn't be asked about this run (and has no earlier answer) is
 * left out. Throws `TmdbAbortError` when the run can't go on.
 */
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
    const lookup = await resolveSearch(
      searchKey('movie', movie.title, movie.year),
      movie.tmdb_id,
      searchCache,
      async () =>
        pickBestMatch(
          movie.title,
          movie.year,
          (await client.searchMovie(movie.title, movie.year)).map(c => ({
            ...c,
            date: c.release_date,
          })),
          { preferFamous: true }
        ),
      `${movie.title} (${movie.year})`
    )
    // TMDB couldn't be asked and there's no earlier answer — leave it for next run.
    if (lookup === null) {
      onProgress?.(i + 1, movies.length, cachedCount)
      continue
    }
    const { resolved } = lookup
    if (lookup.cached) cachedCount++

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
      const id = resolved.best_id
      const details = await cachedFetch(
        detailsCache,
        String(id),
        () => client.getMovie(id),
        `Details for id=${id}`,
        hasCredits
      )
      if (details) {
        entry.tmdb_title = details.title
        entry.tmdb_title_filename_safe = stripFilenameIllegalChars(details.title)
        entry.tmdb_year = parseYear(details.release_date)
        // TMDB reports 0 for records where nobody has filled the runtime in —
        // treat that as "unknown" rather than a zero-length film.
        tmdbRuntime = details.runtime ? details.runtime : null
      }
    }

    // Other candidates the search turned up, for review
    entry.alternatives = alternativesOf(resolved, id => {
      const d = detailsCache.get(String(id))
      return d ? { id, title: d.title, year: parseYear(d.release_date) } : null
    })

    // Emit warnings according to confidence. Path is prefixed with the
    // movie's first category so flat-library and quality-organized users
    // both get a clickable, copy-pasteable folder path. The label is the
    // folder as it sits on disk, so these rows group with the scan's and an
    // ignore entry naming the folder reaches them.
    const movieLabel = movie.folder ?? legacyFolderLabel(movie)
    const moviePath = categoryPath(movie.versions[0]?.category, movieLabel)
    // Editions kept as files in one shared folder all land on that folder, so
    // each row says which edition it's about.
    const lead =
      movie.edition !== null && !movieLabel.includes(`{edition-${movie.edition}}`)
        ? `Edition '${movie.edition}': `
        : ''

    // The displayed path names only the first category, but a movie can sit in
    // several. Give the ignore matcher all of them so a `folders:` entry isn't
    // at the mercy of which category happened to sort first.
    const movieScope = { categories: categoriesOf(movie.versions), levels: [movieLabel] }

    if (resolved.confidence === 'none' && rules.checks.warn_tmdb_no_match) {
      warnings.add(
        'warn_tmdb_no_match',
        moviePath,
        `${lead}TMDB has nothing matching '${movie.title}' (${movie.year}).`,
        {
          fix:
            `Usually a typo in the title or year, or a missing diacritic. Check the folder ` +
            `against themoviedb.org — some obscure films genuinely aren't listed.`,
          scope: movieScope,
        }
      )
    } else if (resolved.confidence === 'low' && rules.checks.warn_tmdb_low_confidence) {
      const altText =
        entry.alternatives.length > 0
          ? ` Alternatives: ${entry.alternatives.map(a => `'${a.title}' (${a.year})`).join(', ')}.`
          : ''
      warnings.add(
        'warn_tmdb_low_confidence',
        moviePath,
        `${lead}${guessText(entry.tmdb_title, entry.tmdb_year, entry.tmdb_id)}, below the confidence ` +
          `threshold.${altText}`,
        {
          fix: `Check the match on themoviedb.org and correct the folder name if it is wrong.`,
          scope: movieScope,
        }
      )
    } else if (
      rules.checks.warn_tmdb_year_mismatch &&
      entry.tmdb_year !== null &&
      entry.tmdb_year !== movie.year
    ) {
      warnings.add(
        'warn_tmdb_year_mismatch',
        moviePath,
        `${lead}Folder says ${movie.year}, TMDB says '${entry.tmdb_title}' is ${entry.tmdb_year}.`,
        {
          fix:
            `Check which is right on themoviedb.org. A wrong year in the folder can also mean ` +
            `TMDB matched a remake.`,
          scope: movieScope,
        }
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
        `${lead}Folder is '${movie.title}', TMDB's filename-safe form is ` +
          `'${entry.tmdb_title_filename_safe}'.`,
        {
          fix:
            `Rename the folder to match if you want TMDB's exact wording. Expected whenever a ` +
            `title matched via the loose tier — this is a suggestion, not an error.`,
          scope: movieScope,
        }
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
        warnings.add(
          'warn_tmdb_runtime_mismatch',
          file.path,
          `File runs ${formatMinutes(localMinutes)}, TMDB says '${entry.tmdb_title}' runs ` +
            `${formatMinutes(tmdbRuntime)} — ${Math.round(drift * 100)}% ${direction}.`,
          {
            // The direction-specific advice can't live on the row: a `fix` is
            // written once per bucket, so it has to cover both cases.
            fix:
              `Shorter is usually a truncated or failed encode — play the file to the end and ` +
              `re-encode from source. Longer is usually a wrong match, two features in one ` +
              `file, or an extended cut TMDB doesn't carry. Tolerance is ` +
              `runtime_tolerance_percent in rules/movies.yaml.`,
          }
        )
      }
    }

    out.push(entry)
    onProgress?.(i + 1, movies.length, cachedCount)
  }

  return out
}
