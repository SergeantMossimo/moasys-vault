/**
 * validate/tmdb.ts
 * ----------------
 * Minimal TMDB API client. Only the four endpoints we need:
 *
 *   GET /3/search/movie?query=...&year=...
 *   GET /3/movie/<id>
 *   GET /3/search/tv?query=...&first_air_date_year=...
 *   GET /3/tv/<id>
 *
 * Rate limiting: TMDB allows ~40 requests per 10 seconds. We use a fixed
 * 250 ms minimum delay between requests (4 rps average) so we never approach
 * the limit. Simpler than a rolling window and the throughput is sufficient
 * for thousands of items.
 *
 * Retries: on HTTP 429 the response carries a `Retry-After` header. We sleep
 * for that duration and retry, up to MAX_429_RETRIES times in a row. Other
 * 4xx/5xx errors, and requests that time out, bubble up as exceptions for the
 * caller to surface as a warning.
 */

import type {
  TmdbMovieSearchResult,
  TmdbMovieDetails,
  TmdbShowSearchResult,
  TmdbShowDetails,
  TmdbSeasonDetails,
} from './types'

const TMDB_BASE = 'https://api.themoviedb.org/3'

/** Fixed per-request delay (ms). 250 ms → 4 rps → well under 40 / 10 s. */
const MIN_REQUEST_DELAY_MS = 250

/** How long to wait when TMDB returns 429 without a Retry-After header (ms). */
const DEFAULT_429_BACKOFF_MS = 10_000

/** Give up on a request after this many consecutive 429s. */
export const MAX_429_RETRIES = 5

/** A request with no response by now is a hung connection, not a slow API. */
const REQUEST_TIMEOUT_MS = 30_000

/** ── Sleep helper ─────────────────────────────────────────────────────── */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ─────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────

export class TmdbClient {
  /** Timestamp of the last successful request — used for the delay calc. */
  private lastRequestAt = 0
  /** Running tally of HTTP requests issued. Surfaced in run summaries. */
  private requestCount = 0

  constructor(
    private apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep
  ) {}

  /** Total HTTP requests issued since this client was created. */
  get totalRequests(): number {
    return this.requestCount
  }

  /**
   * Core fetch wrapper.
   *   1. Enforces MIN_REQUEST_DELAY_MS between requests.
   *   2. Adds api_key query param.
   *   3. Retries on 429, honoring Retry-After, up to MAX_429_RETRIES times.
   *   4. Times out after REQUEST_TIMEOUT_MS.
   *   5. Returns parsed JSON or throws an Error with a useful message.
   *
   * Error messages never include the URL — it carries the API key.
   */
  private async request<T>(pathWithQuery: string, rateLimitRetries = 0): Promise<T> {
    const url = new URL(TMDB_BASE + pathWithQuery)
    url.searchParams.set('api_key', this.apiKey)

    // Throttle so we never hit the 40 / 10 s rate limit.
    const sinceLast = Date.now() - this.lastRequestAt
    if (sinceLast < MIN_REQUEST_DELAY_MS) {
      await this.sleepImpl(MIN_REQUEST_DELAY_MS - sinceLast)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      // No `cause` on either throw: the request URL carries the API key, and a
      // crash handler printing the original error chain could expose it.
      const e = err as Error
      if (e.name === 'TimeoutError') {
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`TMDB request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`TMDB network error: ${e.message}`)
    } finally {
      this.lastRequestAt = Date.now()
      this.requestCount++
    }

    if (response.status === 429) {
      if (rateLimitRetries >= MAX_429_RETRIES) {
        throw new Error(
          `TMDB still rate-limiting after ${MAX_429_RETRIES} retries — try again later`
        )
      }
      const retryAfter = parseInt(response.headers.get('retry-after') ?? '', 10)
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_429_BACKOFF_MS
      console.log(`    [TMDB] Rate-limited, sleeping ${waitMs}ms before retrying...`)
      await this.sleepImpl(waitMs)
      return this.request(pathWithQuery, rateLimitRetries + 1)
    }

    if (response.status === 401) {
      throw new Error('TMDB 401 Unauthorized — check your api_key in .secrets.json')
    }

    if (response.status === 404) {
      // Caller-specific handling — let them branch on this.
      throw new Error('TMDB 404 Not Found')
    }

    if (!response.ok) {
      throw new Error(`TMDB HTTP ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as T
  }

  // ─── Movies ──────────────────────────────────────────────────────────

  /**
   * Search for movies matching `title`. The `year` query param is a STRICT
   * filter on TMDB's `primary_release_date.year` — it does not return close-
   * year matches. So we try a year-filtered search first (best signal-to-
   * noise when TMDB's primary release year matches what's in the folder)
   * and fall back to a title-only search if that returns nothing. The
   * caller still does year-tolerance scoring on whatever comes back, so a
   * one- or two-year discrepancy never blocks a match.
   *
   * Common cases for the fallback: films TMDB lists by their original
   * theatrical release year while the folder uses the wide-release year
   * (or vice versa), films originally released as a web/TV series, and
   * boxed bundle releases.
   */
  async searchMovie(title: string, year: number): Promise<TmdbMovieSearchResult[]> {
    const base = `/search/movie?query=${encodeURIComponent(title)}&include_adult=false&language=en-US`
    const withYear = await this.request<{ results: TmdbMovieSearchResult[] }>(
      `${base}&year=${year}`
    )
    if (withYear.results && withYear.results.length > 0) return withYear.results
    const withoutYear = await this.request<{ results: TmdbMovieSearchResult[] }>(base)
    return withoutYear.results ?? []
  }

  /** Fetch full movie details by TMDB ID. */
  async getMovie(id: number): Promise<TmdbMovieDetails> {
    return this.request<TmdbMovieDetails>(`/movie/${id}?language=en-US`)
  }

  // ─── Shows ───────────────────────────────────────────────────────────

  /**
   * Search for TV shows matching `name`. `first_air_date_year` is a STRICT
   * filter on TMDB, not a bias — same approach as `searchMovie`: try
   * year-filtered first, fall back to title-only on empty. The caller's
   * year-tolerance scoring still handles small discrepancies between
   * TMDB's first-air year and the folder year.
   */
  async searchShow(name: string, year: number): Promise<TmdbShowSearchResult[]> {
    const base = `/search/tv?query=${encodeURIComponent(name)}&include_adult=false&language=en-US`
    const withYear = await this.request<{ results: TmdbShowSearchResult[] }>(
      `${base}&first_air_date_year=${year}`
    )
    if (withYear.results && withYear.results.length > 0) return withYear.results
    const withoutYear = await this.request<{ results: TmdbShowSearchResult[] }>(base)
    return withoutYear.results ?? []
  }

  /**
   * Fetch full show details (including the seasons array with episode counts).
   */
  async getShow(id: number): Promise<TmdbShowDetails> {
    return this.request<TmdbShowDetails>(`/tv/${id}?language=en-US`)
  }

  /**
   * Fetch a single season's details — per-episode titles + air dates.
   * Caller is responsible for caching; this is one request per (show, season).
   * The response is trimmed to what we use — see `slimSeasonDetails`.
   */
  async getShowSeason(showId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
    return slimSeasonDetails(
      await this.request<TmdbSeasonDetails>(`/tv/${showId}/season/${seasonNumber}?language=en-US`)
    )
  }
}

/**
 * Keep only the `TmdbSeasonDetails` fields. TMDB's season response carries
 * each episode's full crew and guest-star lists, overviews and stills — about
 * 60 KB per season, 98% of which nothing reads. Caching it verbatim grew
 * cache/tmdb-show-seasons.json past 90 MB for ~850 seasons.
 *
 * Also applied to entries as the cache loads, so an existing cache shrinks on
 * the next `validate:shows` without re-fetching anything.
 */
export function slimSeasonDetails(season: TmdbSeasonDetails): TmdbSeasonDetails {
  return {
    ...(season.id !== undefined && { id: season.id }),
    season_number: season.season_number,
    ...(season.name !== undefined && { name: season.name }),
    episodes: (season.episodes ?? []).map(ep => ({
      episode_number: ep.episode_number,
      name: ep.name,
      ...(ep.air_date !== undefined && { air_date: ep.air_date }),
    })),
  }
}
