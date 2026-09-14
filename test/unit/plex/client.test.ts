import { describe, it, expect, vi } from 'vitest'

import { PAGE_SIZE, PlexClient } from '../../../src/plex/client'

const TOKEN = 'secret-token-123'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PlexClient', () => {
  it('sends the token as a header, never in the URL, and only issues GETs', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ MediaContainer: { machineIdentifier: 'abc', version: '1.40' } })
    )
    const client = new PlexClient('http://nas:32400/', TOKEN, fetchImpl as unknown as typeof fetch)

    await client.identity()

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://nas:32400/identity')
    expect(url).not.toContain(TOKEN)
    expect((init!.headers as Record<string, string>)['X-Plex-Token']).toBe(TOKEN)
    expect(init!.method).toBeUndefined()
  })

  it('pages through a listing until a short page', async () => {
    const pages = [PAGE_SIZE, PAGE_SIZE, 3]
    const fetchImpl = vi.fn(async (url: string) => {
      const start = Number(new URL(url).searchParams.get('X-Plex-Container-Start'))
      const size = pages[start / PAGE_SIZE]!
      const Metadata = Array.from({ length: size }, (_, i) => ({
        ratingKey: String(start + i),
        type: 'movie',
        title: `M${start + i}`,
      }))
      return jsonResponse({ MediaContainer: { size, Metadata } })
    })
    const client = new PlexClient('http://nas:32400', TOKEN, fetchImpl as unknown as typeof fetch)

    const items = await client.sectionItems('1', 1)
    expect(items).toHaveLength(PAGE_SIZE * 2 + 3)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const firstUrl = new URL(fetchImpl.mock.calls[0]![0])
    expect(firstUrl.searchParams.get('type')).toBe('1')
    expect(firstUrl.searchParams.get('includeGuids')).toBe('1')
  })

  it('stops when the reported total is reached on a full page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        MediaContainer: {
          size: PAGE_SIZE,
          totalSize: PAGE_SIZE,
          Metadata: Array.from({ length: PAGE_SIZE }, (_, i) => ({
            ratingKey: String(i),
            type: 'movie',
            title: 'x',
          })),
        },
      })
    )
    const client = new PlexClient('http://nas:32400', TOKEN, fetchImpl as unknown as typeof fetch)
    await client.sectionItems('1', 1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('explains a rejected token', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }))
    const client = new PlexClient('http://nas:32400', TOKEN, fetchImpl as unknown as typeof fetch)
    await expect(client.sections()).rejects.toThrow(/\.secrets\.json/)
  })

  it('redacts the token from network error messages', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed with ${TOKEN}`)
    })
    const client = new PlexClient('http://nas:32400', TOKEN, fetchImpl as unknown as typeof fetch)
    const error = await client.identity().catch((e: Error) => e)
    expect((error as Error).message).not.toContain(TOKEN)
    expect((error as Error).message).toContain('<redacted>')
  })
})
