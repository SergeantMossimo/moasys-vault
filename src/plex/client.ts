/**
 * plex/client.ts
 * --------------
 * Minimal, READ-ONLY client for a Plex Media Server.
 *
 * Read-only by construction, not by convention: the only way to issue a
 * request is `get()`, and the underlying fetch never sets a method, so it is
 * always GET. There is no code path that could refresh a library, fix a
 * match, empty the trash, or delete anything. Adding one would mean writing
 * a new method, which is exactly the kind of change the repo's read-only
 * rule (CLAUDE.md) asks to be deliberate.
 *
 * Token handling:
 *   - Sent ONLY as the `X-Plex-Token` header, never in the URL, so it can't
 *     leak into logged URLs, error messages, or output files.
 *   - Every error message passes through `redact()` as a second guard.
 *
 * Paging: library listings are fetched in pages via the
 * `X-Plex-Container-Start` / `X-Plex-Container-Size` query parameters, so a
 * large library never has to arrive in one response.
 */

import {
  PlexIdentity,
  PlexMetadata,
  PlexMetadataContainer,
  PlexResponse,
  PlexSection,
  PlexSectionsContainer,
} from './types'

/** Items per page. Large enough to keep request counts low, small enough to keep each response quick. */
export const PAGE_SIZE = 500

/** A slow NAS can take a while on a big first page; anything past this is a hung connection. */
const REQUEST_TIMEOUT_MS = 60_000

/** Small gap between requests so a pull never hammers the server. */
const MIN_REQUEST_DELAY_MS = 50

/** Identifies this tool in Plex's "Devices" list and logs. */
const CLIENT_HEADERS = {
  'X-Plex-Product': 'MOASYS-Vault',
  'X-Plex-Client-Identifier': 'moasys-vault',
  'X-Plex-Version': '1.0',
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class PlexClient {
  private lastRequestAt = 0
  private requestCount = 0
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** Total HTTP requests issued since this client was created. */
  get totalRequests(): number {
    return this.requestCount
  }

  /** Remove the token from any text before it's shown or thrown. */
  redact(text: string): string {
    return this.token ? text.split(this.token).join('<redacted>') : text
  }

  /**
   * GET a path and return its parsed JSON. `params` become query parameters.
   * The only request primitive in this client.
   */
  async get<T>(pathname: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(this.baseUrl + pathname)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    const sinceLast = Date.now() - this.lastRequestAt
    if (sinceLast < MIN_REQUEST_DELAY_MS) await sleep(MIN_REQUEST_DELAY_MS - sinceLast)

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json', 'X-Plex-Token': this.token, ...CLIENT_HEADERS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(
        this.redact(
          `Could not reach Plex at ${this.baseUrl} (${(err as Error).message}). ` +
            `Check plex.url in config.json and that the server is running.`
        )
      )
    } finally {
      this.lastRequestAt = Date.now()
      this.requestCount++
    }

    if (response.status === 401) {
      throw new Error(
        'Plex rejected the token (401 Unauthorized). Check plex.token in .secrets.json — ' +
          'tokens change when you sign out of all devices or change your password.'
      )
    }
    if (!response.ok) {
      throw new Error(
        this.redact(`Plex HTTP ${response.status} ${response.statusText} for ${pathname}`)
      )
    }

    const body = (await response.json()) as PlexResponse<T>
    return body.MediaContainer
  }

  /**
   * GET every page of a Metadata listing and return the combined items.
   * Stops when a page comes back short or the reported total is reached.
   */
  async getAllMetadata(
    pathname: string,
    params: Record<string, string | number> = {},
    onPage?: (fetched: number, total: number | null) => void
  ): Promise<PlexMetadata[]> {
    const items: PlexMetadata[] = []
    for (let start = 0; ; start += PAGE_SIZE) {
      const page = await this.get<PlexMetadataContainer>(pathname, {
        ...params,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE_SIZE,
      })
      const batch = page.Metadata ?? []
      items.push(...batch)
      const total = page.totalSize ?? null
      onPage?.(items.length, total)
      if (batch.length < PAGE_SIZE) break
      if (total !== null && items.length >= total) break
    }
    return items
  }

  // ─── Endpoints ───────────────────────────────────────────────────────

  /** Server identity. Doubles as the connectivity + token check. */
  identity(): Promise<PlexIdentity> {
    return this.get<PlexIdentity>('/identity')
  }

  /** Every library on the server, with its folder locations. */
  async sections(): Promise<PlexSection[]> {
    const container = await this.get<PlexSectionsContainer>('/library/sections')
    return container.Directory ?? []
  }

  /** Every item of one type in a library, with media parts and external ids. */
  sectionItems(
    sectionKey: string,
    typeNumber: number,
    extra: Record<string, string | number> = {},
    onPage?: (fetched: number, total: number | null) => void
  ): Promise<PlexMetadata[]> {
    return this.getAllMetadata(
      `/library/sections/${encodeURIComponent(sectionKey)}/all`,
      { type: typeNumber, includeGuids: 1, ...extra },
      onPage
    )
  }

  /** The collections in a library. */
  collections(sectionKey: string): Promise<PlexMetadata[]> {
    return this.getAllMetadata(`/library/sections/${encodeURIComponent(sectionKey)}/collections`)
  }

  /** The items inside one collection. */
  collectionItems(ratingKey: string): Promise<PlexMetadata[]> {
    return this.getAllMetadata(`/library/collections/${encodeURIComponent(ratingKey)}/children`)
  }
}
