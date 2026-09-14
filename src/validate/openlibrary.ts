/**
 * validate/openlibrary.ts
 * -----------------------
 * Minimal Open Library search client for audiobook validation. One endpoint:
 *
 *   GET https://openlibrary.org/search.json?q=...&author=...&fields=...&limit=...
 *
 * No API key. Open Library asks API users to identify themselves with a
 * User-Agent and to keep request rates modest, so every request carries a
 * project User-Agent and we hold a fixed 1 s gap between requests. That makes
 * a first run over ~100 books take a couple of minutes; warm runs hit the
 * cache and make no requests at all.
 *
 * Retries: one retry on HTTP 429/503, honoring Retry-After. Other failures
 * throw for the caller to log and treat as "no result".
 */

const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json'

/** Fixed per-request delay (ms). Open Library has no published limit; 1 rps is polite. */
const MIN_REQUEST_DELAY_MS = 1000

/** Wait used when a 429/503 has no Retry-After header (ms). */
const DEFAULT_BACKOFF_MS = 10_000

/** How many results to ask for. Several editions of one book are common, so more than one. */
const RESULT_LIMIT = 10

/**
 * Identifies this tool to Open Library, as their API guidelines request.
 * Deliberately carries no personal contact details.
 */
const USER_AGENT = 'MOASYS-Vault/1.0 (personal media library scanner)'

/** Only the fields we read — keeps responses and the cache small. */
const FIELDS = 'key,title,subtitle,author_name,first_publish_year'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** One search result ("doc"), trimmed to the fields requested. */
export interface OpenLibraryDoc {
  /** Work key, e.g. `/works/OL82563W`. */
  key: string
  title: string
  subtitle?: string
  author_name?: string[]
  first_publish_year?: number
}

interface OpenLibrarySearchResponse {
  numFound: number
  docs: OpenLibraryDoc[]
}

// ─────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────

export class OpenLibraryClient {
  private lastRequestAt = 0
  private requestCount = 0

  /** Total HTTP requests issued since this client was created. */
  get totalRequests(): number {
    return this.requestCount
  }

  /**
   * Search by free-text query, optionally narrowed to an author. `q` searches
   * title and subtitle together, which matters for folder names that join
   * them with ` - ` — a `title=` search for `Halo The Flood` misses books
   * Open Library stores as title `Halo`, subtitle `The Flood`.
   */
  async search(query: string, author?: string): Promise<OpenLibraryDoc[]> {
    const url = new URL(OPENLIBRARY_SEARCH)
    url.searchParams.set('q', query)
    if (author) url.searchParams.set('author', author)
    url.searchParams.set('fields', FIELDS)
    url.searchParams.set('limit', String(RESULT_LIMIT))
    const body = await this.request<OpenLibrarySearchResponse>(url)
    return body.docs ?? []
  }

  private async request<T>(url: URL, retried = false): Promise<T> {
    const sinceLast = Date.now() - this.lastRequestAt
    if (sinceLast < MIN_REQUEST_DELAY_MS) {
      await sleep(MIN_REQUEST_DELAY_MS - sinceLast)
    }

    let response: Response
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
    } catch (err) {
      throw new Error(`Open Library network error: ${(err as Error).message}`)
    } finally {
      this.lastRequestAt = Date.now()
      this.requestCount++
    }

    if ((response.status === 429 || response.status === 503) && !retried) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS
      console.log(
        `    [OPENLIBRARY] HTTP ${response.status}, sleeping ${waitMs}ms before retrying...`
      )
      await sleep(waitMs)
      return this.request(url, true)
    }

    if (!response.ok) {
      throw new Error(`Open Library HTTP ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as T
  }
}
