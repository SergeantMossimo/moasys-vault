/**
 * core/gaps.ts
 * ------------
 * Generic numeric gap detection. Used by shows (episodes),
 * music (tracks), and audiobooks (chapters) to surface missing
 * items inside an otherwise sequential set.
 */

/**
 * Return the integers missing between the min and max of `numbers`.
 * Example: [1, 2, 4] -> [3]
 * Returns [] for an empty input.
 */
export function findNumericGaps(numbers: number[]): number[] {
  if (numbers.length === 0) return []
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const present = new Set(numbers)
  const gaps: number[] = []
  for (let i = min; i <= max; i++) {
    if (!present.has(i)) gaps.push(i)
  }
  return gaps
}

/** How many ranges `formatGaps` lists before summarizing the rest. */
const GAP_RANGE_LIMIT = 8

/**
 * Render gaps for a warning message: consecutive runs collapse into ranges and
 * the list stops after `GAP_RANGE_LIMIT` of them. A long-running show once
 * produced a single 3,600-character row listing every missing episode one by one.
 *
 * Example: [2, 3, 4, 7, 9, 10] with `n => 'E' + pad(n)` -> "E02–E04, E07, E09–E10"
 */
export function formatGaps(gaps: number[], label: (n: number) => string): string {
  const ranges: Array<[number, number]> = []
  for (const g of [...gaps].sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last && g === last[1] + 1) last[1] = g
    else ranges.push([g, g])
  }
  const shown = ranges
    .slice(0, GAP_RANGE_LIMIT)
    .map(([a, b]) => (a === b ? label(a) : `${label(a)}–${label(b)}`))
  const rest = ranges.slice(GAP_RANGE_LIMIT).reduce((n, [a, b]) => n + b - a + 1, 0)
  return shown.join(', ') + (rest > 0 ? `, +${rest} more` : '')
}
