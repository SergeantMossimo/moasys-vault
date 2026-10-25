import { describe, it, expect } from 'vitest'

import { mapConcurrent } from '../../../src/plex/pull'

describe('mapConcurrent', () => {
  it('keeps input order however the calls finish', async () => {
    const delays = [30, 5, 20, 1, 10]
    const out = await mapConcurrent(delays, 3, async ms => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return ms
    })
    expect(out).toEqual(delays)
  })

  it('never has more than `limit` calls in flight', async () => {
    let running = 0
    let peak = 0
    await mapConcurrent(
      Array.from({ length: 12 }, (_, i) => i),
      4,
      async i => {
        running++
        peak = Math.max(peak, running)
        await new Promise(resolve => setTimeout(resolve, (i % 3) + 1))
        running--
      }
    )
    expect(peak).toBe(4)
  })

  it('handles an empty list', async () => {
    expect(await mapConcurrent([], 4, async x => x)).toEqual([])
  })

  it('rejects when a call does', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('collection 2 failed')
        return n
      })
    ).rejects.toThrow('collection 2 failed')
  })
})
