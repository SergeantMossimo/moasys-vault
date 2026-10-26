/**
 * plex/collections-writer.ts
 * --------------------------
 * The ONLY code in this project that changes anything on a Plex server, and
 * it can change only collections: create one, add items to one, remove one
 * item from one. Nothing here can touch a media file, an item's metadata, a
 * library, or delete a collection.
 *
 * That's enforced, not hoped for. Every request goes through `send()`, and
 * `send()` calls `assertCollectionWrite()` first, which throws for anything
 * but these three shapes:
 *
 *   POST   /library/collections                       create (type, title, smart=0, sectionId, uri)
 *   PUT    /library/collections/<id>/items            add    (uri)
 *   DELETE /library/collections/<id>/items/<itemId>   remove one item
 *
 * and checks every id against what this run read from the selected library:
 * the `uri` must name this server and only items listed in that library, and
 * a collection id must be one the library has (or that this run created).
 * Collections live in Plex's database, not in the media files — see
 * CLAUDE.md, "Exception: Plex collections". Widening the allowlist needs the
 * user's explicit approval.
 *
 * Reading stays in plex/client.ts, which remains GET-only.
 */

import { CLIENT_HEADERS, REQUEST_TIMEOUT_MS } from './client'

export type WriteMethod = 'POST' | 'PUT' | 'DELETE'

export interface CollectionWrite {
  method: WriteMethod
  path: string
  params: Record<string, string>
}

/** What this run may touch: one server, one library, ids it has seen. */
export interface WriteScope {
  machineId: string
  sectionKey: string
  /** Plex type number of the library's items: 1 movie, 2 show, 9 album. */
  typeNumber: number
  /** Rating keys of items listed in the library this run. */
  itemKeys: ReadonlySet<string>
  /** Rating keys of the library's collections, plus any this run created. */
  collectionKeys: Set<string>
}

/** Item types a collection can be made of here. */
export const COLLECTION_TYPE_NUMBERS: ReadonlySet<number> = new Set([1, 2, 9])

/** Pause between writes, so a long run never hammers the server. */
export const WRITE_DELAY_MS = 250

const URI_PREFIX = '/com.plexapp.plugins.library/library/metadata/'
const DIGITS = /^\d+$/
const ADD_PATH = /^\/library\/collections\/(\d+)\/items$/
const REMOVE_PATH = /^\/library\/collections\/(\d+)\/items\/(\d+)$/

/** The `uri` Plex expects for a list of items on this server. */
export function metadataUri(machineId: string, ratingKeys: string[]): string {
  return `server://${machineId}${URI_PREFIX}${ratingKeys.join(',')}`
}

function fail(req: CollectionWrite, why: string): never {
  throw new Error(
    `Refused Plex write ${req.method} ${req.path}: ${why}. Only collection changes are allowed.`
  )
}

function exactParams(req: CollectionWrite, keys: string[]): void {
  const got = Object.keys(req.params).sort()
  const want = [...keys].sort()
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    fail(req, `parameters must be exactly [${want.join(', ')}], got [${got.join(', ')}]`)
  }
}

function checkUri(req: CollectionWrite, scope: WriteScope): void {
  const uri = req.params.uri ?? ''
  const prefix = `server://${scope.machineId}${URI_PREFIX}`
  if (!uri.startsWith(prefix)) fail(req, 'uri must name items on this server')
  const keys = uri.slice(prefix.length).split(',')
  if (keys.length === 0 || keys.some(k => !DIGITS.test(k)))
    fail(req, 'uri must list numeric item ids')
  const foreign = keys.filter(k => !scope.itemKeys.has(k))
  if (foreign.length) fail(req, `item ${foreign[0]} isn't in the selected library`)
}

function checkCollection(req: CollectionWrite, key: string, scope: WriteScope): void {
  if (!scope.collectionKeys.has(key)) fail(req, `collection ${key} isn't in the selected library`)
}

/** Throw unless `req` is one of the three allowed collection changes, within `scope`. */
export function assertCollectionWrite(req: CollectionWrite, scope: WriteScope): void {
  if (req.method === 'POST') {
    if (req.path !== '/library/collections')
      fail(req, 'POST is only allowed to create a collection')
    exactParams(req, ['type', 'title', 'smart', 'sectionId', 'uri'])
    if (req.params.smart !== '0') fail(req, 'only regular (non-smart) collections can be created')
    if (req.params.sectionId !== scope.sectionKey)
      fail(req, 'sectionId must be the selected library')
    const type = Number(req.params.type)
    if (!COLLECTION_TYPE_NUMBERS.has(type) || type !== scope.typeNumber)
      fail(req, 'type must match the library')
    if (!req.params.title?.trim()) fail(req, 'a collection needs a title')
    checkUri(req, scope)
    return
  }
  if (req.method === 'PUT') {
    const m = ADD_PATH.exec(req.path)
    if (!m) fail(req, 'PUT is only allowed to add items to a collection')
    exactParams(req, ['uri'])
    checkCollection(req, m[1]!, scope)
    checkUri(req, scope)
    return
  }
  if (req.method === 'DELETE') {
    const m = REMOVE_PATH.exec(req.path)
    if (!m) fail(req, 'DELETE is only allowed to take one item out of a collection')
    exactParams(req, [])
    checkCollection(req, m[1]!, scope)
    if (!scope.itemKeys.has(m[2]!)) fail(req, `item ${m[2]} isn't in the selected library`)
    return
  }
  fail(req, 'method not allowed')
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class PlexCollectionsWriter {
  private readonly baseUrl: string
  private lastWriteAt = 0
  private writes = 0

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly scope: WriteScope,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly delayMs = WRITE_DELAY_MS
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  get totalWrites(): number {
    return this.writes
  }

  /** Create a collection holding `ratingKeys`; returns its new rating key. */
  async create(title: string, ratingKeys: string[]): Promise<string> {
    const response = await this.send({
      method: 'POST',
      path: '/library/collections',
      params: {
        type: String(this.scope.typeNumber),
        title,
        smart: '0',
        sectionId: this.scope.sectionKey,
        uri: metadataUri(this.scope.machineId, ratingKeys),
      },
    })
    const body = (await response.json()) as {
      MediaContainer?: { Metadata?: Array<{ ratingKey?: string }> }
    }
    const key = body.MediaContainer?.Metadata?.[0]?.ratingKey
    if (!key || !DIGITS.test(key))
      throw new Error(`Plex created "${title}" but didn't return its id`)
    this.scope.collectionKeys.add(key)
    return key
  }

  async add(collectionKey: string, ratingKeys: string[]): Promise<void> {
    await this.send({
      method: 'PUT',
      path: `/library/collections/${collectionKey}/items`,
      params: { uri: metadataUri(this.scope.machineId, ratingKeys) },
    })
  }

  async remove(collectionKey: string, ratingKey: string): Promise<void> {
    await this.send({
      method: 'DELETE',
      path: `/library/collections/${collectionKey}/items/${ratingKey}`,
      params: {},
    })
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('<redacted>') : text
  }

  /** The single place a write leaves this process. */
  private async send(req: CollectionWrite): Promise<Response> {
    assertCollectionWrite(req, this.scope)

    const url = new URL(this.baseUrl + req.path)
    for (const [k, v] of Object.entries(req.params)) url.searchParams.set(k, v)

    const since = Date.now() - this.lastWriteAt
    if (this.writes > 0 && since < this.delayMs) await sleep(this.delayMs - since)

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method: req.method,
        headers: { Accept: 'application/json', 'X-Plex-Token': this.token, ...CLIENT_HEADERS },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      // No `cause`: only the redacted message may leave, as in plex/client.ts.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        this.redact(`Could not reach Plex at ${this.baseUrl} (${(err as Error).message})`)
      )
    } finally {
      this.lastWriteAt = Date.now()
      this.writes++
    }
    if (!response.ok) {
      throw new Error(
        this.redact(
          `Plex HTTP ${response.status} ${response.statusText} for ${req.method} ${req.path}`
        )
      )
    }
    return response
  }
}
