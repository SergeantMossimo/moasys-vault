/**
 * validate/tmdb.ts
 * ----------------
 * Minimal TMDB API client. Only the five endpoints we need:
 *
 *   GET /3/search/movie?query=...&year=...
 *   GET /3/movie/<id>
 *   GET /3/search/tv?query=...&first_air_date_year=...
 *   GET /3/tv/<id>
 *   GET /3/tv/<id>/season/<n>
 *
 * Rate limiting: a fixed 250 ms minimum delay between requests (4 rps). TMDB
 * is generous these days, but a steady pace keeps a several-thousand-title
 * first run polite, and the throughput is plenty.
 *
 * Retries:
 *   - HTTP 429 carries a `Retry-After` header; we sleep for it and retry, up
 *     to MAX_429_RETRIES times in a row.
 *   - A network error, a timeout, or a 5xx is retried TRANSIENT_RETRIES times
 *     with a growing pause, then thrown for the caller to handle per title.
 *
 * Two failures end the run instead, as a `TmdbAbortError`: a 401 (the key is
 * wrong, so every request would fail) and MAX_CONSECUTIVE_FAILURES titles in a
 * row failing (TMDB, or the network, is down). Carrying on would record every
 * title as "no match" and overwrite good results with nothing.
 */

import type {
  TmdbMovieSearchResult,
  TmdbMovieDetails,
  TmdbShowSearchResult,
  TmdbShowDetails,
  TmdbSeasonDetails,
  TmdbCastMember,
  TmdbCredits,
  TmdbCrewMember,
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

/** Extra attempts for a network error, timeout, or 5xx, pausing 2s, then 4s. */
export const TRANSIENT_RETRIES = 2
const TRANSIENT_BACKOFF_MS = 2_000

/**
 * Most sub-requests one `append_to_response` may carry. TMDB answers 21 or
 * more with a 400 ("The maximum number of remote calls is 20"), checked
 * against the live API in October 2026.
 */
export const MAX_APPENDED = 20

/** This many requests failing back to back means TMDB is unreachable — stop. */
export const MAX_CONSECUTIVE_FAILURES = 5

/**
 * A failure that makes the rest of the run pointless: the API key was
 * rejected, or TMDB stopped answering. The runner stops validating TMDB types
 * and writes nothing for the type in progress, so the previous results stand.
 */
export class TmdbAbortError extends Error {
  override name = 'TmdbAbortError'
}

/** A failure that's worth another try: no response, or a server-side error. */
class TransientError extends Error {}

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
  /** Requests that failed in a row, after their own retries. */
  private consecutiveFailures = 0

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
   * Issue one request with transient retries, and keep the run-wide tally
   * that turns a dead connection into a `TmdbAbortError`.
   */
  private async request<T>(pathWithQuery: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.requestOnce<T>(pathWithQuery)
        this.consecutiveFailures = 0
        return result
      } catch (err) {
        if (err instanceof TransientError && attempt < TRANSIENT_RETRIES) {
          await this.sleepImpl(TRANSIENT_BACKOFF_MS * 2 ** attempt)
          continue
        }
        if (err instanceof TmdbAbortError) throw err
        // A 404 is an answer, not an outage.
        if (err instanceof TransientError || /rate-limiting/.test((err as Error).message)) {
          this.consecutiveFailures++
        }
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new TmdbAbortError(
            `TMDB unreachable — ${MAX_CONSECUTIVE_FAILURES} requests in a row failed (last: ${(err as Error).message}). Check the connection and try again.`
          )
        }
        throw err
      }
    }
  }

  /**
   * One HTTP request.
   *   1. Enforces MIN_REQUEST_DELAY_MS between requests.
   *   2. Adds api_key query param.
   *   3. Retries on 429, honoring Retry-After, up to MAX_429_RETRIES times.
   *   4. Times out after REQUEST_TIMEOUT_MS.
   *   5. Returns parsed JSON or throws an Error with a useful message —
   *      `TransientError` for anything worth retrying.
   *
   * Error messages never include the URL — it carries the API key.
   */
  private async requestOnce<T>(pathWithQuery: string, rateLimitRetries = 0): Promise<T> {
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
        throw new TransientError(`TMDB request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
      }
      throw new TransientError(`TMDB network error: ${e.message}`)
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
      return this.requestOnce(pathWithQuery, rateLimitRetries + 1)
    }

    if (response.status === 401) {
      throw new TmdbAbortError('TMDB rejected the API key (401) — check api_key in .secrets.json')
    }

    if (response.status === 404) {
      // Caller-specific handling — let them branch on this.
      throw new Error('TMDB 404 Not Found')
    }

    if (response.status >= 500) {
      throw new TransientError(`TMDB HTTP ${response.status} ${response.statusText}`)
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

  /** Fetch full movie details by TMDB ID, with credits and keywords appended. */
  async getMovie(id: number): Promise<TmdbMovieDetails> {
    return slimMovieDetails(
      await this.request<TmdbMovieDetails>(
        `/movie/${id}?language=en-US&append_to_response=credits,keywords`
      )
    )
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
   * Fetch full show details (including the seasons array with episode counts),
   * with credits and keywords appended.
   */
  async getShow(id: number): Promise<TmdbShowDetails> {
    return slimShowDetails(
      await this.request<TmdbShowDetails>(
        `/tv/${id}?language=en-US&append_to_response=aggregate_credits,keywords`
      )
    )
  }

  /**
   * Fetch several seasons' details at once: up to MAX_APPENDED per request,
   * appended to the show's own record (`/tv/<id>?append_to_response=season/1,…`),
   * which TMDB returns under `season/<n>` keys. A long-running show's seasons
   * cost one or two requests instead of one each. A season TMDB leaves out of
   * the response is simply absent from the map.
   */
  async getShowSeasons(showId: number, seasons: number[]): Promise<Map<number, TmdbSeasonDetails>> {
    const out = new Map<number, TmdbSeasonDetails>()
    for (let i = 0; i < seasons.length; i += MAX_APPENDED) {
      const batch = seasons.slice(i, i + MAX_APPENDED)
      const appended = batch.map(n => `season/${n}`).join(',')
      const body = await this.request<Record<string, TmdbSeasonDetails | undefined>>(
        `/tv/${showId}?language=en-US&append_to_response=${appended}`
      )
      for (const n of batch) {
        const season = body[`season/${n}`]
        if (season) out.set(n, slimSeasonDetails(season))
      }
    }
    return out
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

/** Top-billed cast kept per title — enough for lead-actor collections. */
export const KEPT_CAST = 20

/**
 * Crew worth keeping: the director, and every Writing-department credit —
 * the screenplay and also what it's based on. TMDB names the source in many
 * ways (Novel, Short Story, Comic Book, Characters, Theatre Play, …), so the
 * whole department is kept rather than a list of jobs that misses some. A
 * crew entry with no department has already been trimmed, so it's kept.
 */
function keptCrewJob(job: string, department: string | undefined): boolean {
  return job === 'Director' || (department ?? 'Writing') === 'Writing'
}

/** A cast or crew entry as `/credits` or `/aggregate_credits` returns it. */
interface RawCredit {
  id: number
  name: string
  character?: string
  job?: string
  department?: string
  roles?: Array<{ character?: string }>
  jobs?: Array<{ job: string }>
}

/** Keywords as TMDB nests them: `keywords` on a movie, `results` on a show. */
type RawKeywords = { keywords?: Array<{ name: string }>; results?: Array<{ name: string }> }

/**
 * Trim appended credits to `TmdbCredits`. A movie's crew has one `job` per
 * entry; a show's aggregate crew has a `jobs` list and its cast a `roles`
 * list, so both shapes flatten to the same one. A full cast and crew runs to
 * tens of KB per title, almost all of it uncredited extras and department
 * staff.
 */
function slimCredits(raw: { cast?: RawCredit[]; crew?: RawCredit[] }): TmdbCredits {
  const cast: TmdbCastMember[] = (raw.cast ?? []).slice(0, KEPT_CAST).map(c => {
    const character = c.character ?? c.roles?.[0]?.character
    return { id: c.id, name: c.name, ...(character && { character }) }
  })
  const crew: TmdbCrewMember[] = []
  for (const c of raw.crew ?? []) {
    const jobs = c.job !== undefined ? [c.job] : (c.jobs ?? []).map(j => j.job)
    for (const job of jobs) {
      if (keptCrewJob(job, c.department)) crew.push({ id: c.id, name: c.name, job })
    }
  }
  return { cast, crew }
}

function slimKeywords(raw: RawKeywords | string[]): string[] {
  if (Array.isArray(raw)) return raw
  return (raw.keywords ?? raw.results ?? []).map(k => k.name)
}

/**
 * Trim the appended `credits` and `keywords` on a movie's details. Every other
 * field is kept as TMDB sent it. A response without them (a test double, or an
 * entry cached before they were requested) passes through unchanged.
 * Idempotent.
 */
export function slimMovieDetails(details: TmdbMovieDetails): TmdbMovieDetails {
  const raw = details as TmdbMovieDetails & { credits?: unknown; keywords?: unknown }
  return {
    ...details,
    ...(raw.credits !== undefined && {
      credits: slimCredits(raw.credits as { cast?: RawCredit[]; crew?: RawCredit[] }),
    }),
    ...(raw.keywords !== undefined && {
      keywords: slimKeywords(raw.keywords as RawKeywords | string[]),
    }),
  }
}

/**
 * As `slimMovieDetails`, for a show: TMDB's `aggregate_credits` (every
 * season's cast and crew, merged) is stored as `credits`.
 */
export function slimShowDetails(details: TmdbShowDetails): TmdbShowDetails {
  const { aggregate_credits: aggregate, ...rest } = details as TmdbShowDetails & {
    aggregate_credits?: { cast?: RawCredit[]; crew?: RawCredit[] }
  }
  const raw = rest as TmdbShowDetails & { credits?: unknown; keywords?: unknown }
  const credits =
    aggregate ?? (raw.credits as { cast?: RawCredit[]; crew?: RawCredit[] } | undefined)
  return {
    ...rest,
    ...(credits !== undefined && { credits: slimCredits(credits) }),
    ...(raw.keywords !== undefined && {
      keywords: slimKeywords(raw.keywords as RawKeywords | string[]),
    }),
  }
}
