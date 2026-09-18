import { describe, it, expect } from 'vitest'

import { findNumericGaps, formatGaps } from '../../../src/core/gaps'

describe('findNumericGaps', () => {
  it('returns empty for an empty array', () => {
    expect(findNumericGaps([])).toEqual([])
  })

  it('returns empty for a single value (no range to have gaps)', () => {
    expect(findNumericGaps([5])).toEqual([])
  })

  it('returns empty for a consecutive sequence', () => {
    expect(findNumericGaps([1, 2, 3, 4, 5])).toEqual([])
  })

  it('returns the missing value in a simple gap', () => {
    expect(findNumericGaps([1, 2, 4])).toEqual([3])
  })

  it('returns multiple missing values', () => {
    expect(findNumericGaps([1, 2, 5, 8, 10])).toEqual([3, 4, 6, 7, 9])
  })

  it('handles unsorted input correctly', () => {
    expect(findNumericGaps([4, 1, 2])).toEqual([3])
  })

  it('handles duplicate values without adding bogus gaps', () => {
    expect(findNumericGaps([1, 2, 2, 4])).toEqual([3])
  })

  it('starts the range from the minimum, not from 0 or 1', () => {
    // Range 5..7 with 6 missing - shouldn't report 1, 2, 3, 4.
    expect(findNumericGaps([5, 7])).toEqual([6])
  })

  it('handles negative numbers if they appear', () => {
    expect(findNumericGaps([-2, 0])).toEqual([-1])
  })

  it('handles a large flat sequence', () => {
    const nums = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(findNumericGaps(nums)).toEqual([])
  })
})

describe('formatGaps', () => {
  const ep = (n: number) => `E${String(n).padStart(2, '0')}`

  it('lists isolated gaps one by one', () => {
    expect(formatGaps([3, 7], ep)).toBe('E03, E07')
  })

  it('collapses consecutive runs into ranges', () => {
    expect(formatGaps([2, 3, 4, 7, 9, 10], ep)).toBe('E02–E04, E07, E09–E10')
  })

  it('sorts its input first', () => {
    expect(formatGaps([4, 2, 3], ep)).toBe('E02–E04')
  })

  it('stops after eight ranges and counts the missing items it left out', () => {
    // Nine isolated gaps plus a run of three: 8 shown, then 1 + 3 = 4 more.
    const gaps = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 21, 22]
    expect(formatGaps(gaps, ep)).toBe('E02, E04, E06, E08, E10, E12, E14, E16, +4 more')
  })
})
