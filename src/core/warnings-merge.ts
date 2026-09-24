/**
 * core/warnings-merge.ts
 * ----------------------
 * Fold the four per-command warnings files into one entry per top-level
 * folder — the shape `npm run report` writes to all-warnings.json.
 *
 * Why this exists: the commands run at different times and each writes its own
 * file, so a show with a naming problem and a missing-episode problem is listed
 * twice and has to be joined by hand. On one real drive 56 of 155 shows appear
 * in both `warnings.json` and `validation-warnings.json` — and two of the
 * checks involved (`warn_episode_gaps` and `warn_tmdb_episode_count`) are
 * different detectors for the same defect.
 *
 * Pure: it takes already-parsed sources and returns the merged shape, so the
 * merge logic is testable without touching disk. `src/report.ts` does the
 * reading and writing.
 */

import { canonicalName } from './ignored'
import type { IgnoreMediaType } from './ignored'
import type {
  MergedWarningFolder,
  MergedWarningRow,
  MergedWarningsOutput,
  WarningSource,
  WarningsOutput,
} from './types'

/**
 * One source's contribution: the command that writes it, where it lives, and
 * what was found there. `data` is null whenever the file could not be used —
 * the reason is on `status`.
 */
export interface MergeInput {
  /** The npm command that writes it — what you re-run to refresh it. */
  command: string
  /** File name within output/<drive>/<type>/. */
  file: string
  /** The exact command line that refreshes it, e.g. `npm run validate:shows external`. */
  rerun: string
  /** Parsed contents, or null when missing/unreadable. */
  data: WarningsOutput | null
  /** Set when `data` is null: why. */
  problem?: 'missing' | 'unreadable'
  /** Extra detail for an unreadable file, e.g. a parse error. */
  detail?: string
}

/** The command whose timestamp every other source is judged against. */
const REFERENCE_COMMAND = 'scan'

/**
 * Is `data` actually the current warnings shape?
 *
 * A file left by a version before the folder regrouping parses fine but has no
 * `folders`, so it would silently contribute nothing. Checking the shape turns
 * that into a visible `unreadable` with a re-run hint.
 */
export function isWarningsOutput(data: unknown): data is WarningsOutput {
  if (data === null || typeof data !== 'object') return false
  const candidate = data as Partial<WarningsOutput>
  return Array.isArray(candidate.folders) && typeof candidate.generated === 'string'
}

/** `Never run — \`npm run validate:shows external\`.` and friends. */
function noteFor(status: WarningSource['status'], input: MergeInput): string {
  const rerun = `\`${input.rerun}\``
  switch (status) {
    case 'missing':
      return `Never run — ${rerun}. Nothing from this command is in this report.`
    case 'stale':
      return `Older than the scan — folded in anyway, but it describes a library state that may have changed. Re-run ${rerun}.`
    case 'unreadable':
      return `Could not be used${input.detail === undefined ? '' : ` (${input.detail})`} — nothing from it is in this report. Re-run ${rerun}.`
    case 'ok':
      return ''
  }
}

/**
 * Describe each source: whether it was usable, and whether it predates the
 * scan.
 *
 * `count` is **null rather than 0** for anything not folded in. A source that
 * never ran must not read as "clean" — that distinction is the reason the
 * `sources` block exists at all.
 *
 * Staleness is measured against the scan rather than a wall-clock threshold,
 * because validate and plex:check both read `data/probe.json`: anything older
 * than the scan is describing a library that has since moved on. When the scan
 * file itself is absent, staleness is undecidable, so nothing is flagged.
 */
export function describeSources(inputs: MergeInput[]): WarningSource[] {
  const reference = inputs.find(i => i.command === REFERENCE_COMMAND)?.data?.generated

  return inputs.map(input => {
    const status: WarningSource['status'] =
      input.data === null
        ? (input.problem ?? 'missing')
        : reference !== undefined && input.data.generated < reference
          ? 'stale'
          : 'ok'

    const note = noteFor(status, input)
    return {
      command: input.command,
      file: input.file,
      status,
      generated: input.data?.generated ?? null,
      // Unreadable and missing sources contribute nothing, so they report
      // null — never a count that could be mistaken for "found nothing".
      count: input.data === null ? null : input.data.count,
      ...(note === '' ? {} : { note }),
    }
  })
}

/**
 * Fold every source's folders together, keying on the same canonical form the
 * ignore matcher uses so one show can't split in two across files.
 *
 * Rows are **not** deduplicated. Two sources reporting the same season are two
 * findings about it, both worth acting on — the row ordering just puts them
 * next to each other.
 */
export function mergeWarnings(
  inputs: MergeInput[],
  opts: { mediaType: IgnoreMediaType; drive: string }
): MergedWarningsOutput {
  const sources = describeSources(inputs)
  const order = new Map(inputs.map((input, i) => [input.command, i]))

  const groups = new Map<string, MergedWarningFolder>()
  const byType: Record<string, number> = {}

  for (const input of inputs) {
    if (input.data === null) continue

    for (const folder of input.data.folders) {
      // The folder's whole path, case-folded. Equivalent to the category plus
      // `canonicalName(mediaType, 1, name)` this used before those two fields
      // were written out: level-1 canonicalization is a plain trim-and-lowercase
      // for every media type, and the season fold only applies at level 2,
      // which a folder path never reaches. So a case-different spelling of one
      // show still folds into one entry, and the same name under two categories
      // still stays two — their paths differ in the category segment.
      const key = folder.path.trim().toLowerCase()
      const rows: MergedWarningRow[] = folder.rows.map(row => ({
        command: input.command,
        ...row,
      }))
      for (const row of rows) byType[row.type] = (byType[row.type] ?? 0) + 1

      const existing = groups.get(key)
      if (existing === undefined) {
        groups.set(key, {
          path: folder.path,
          count: rows.length,
          commands: [input.command],
          rows,
        })
        continue
      }

      existing.count += rows.length
      if (!existing.commands.includes(input.command)) existing.commands.push(input.command)
      existing.rows.push(...rows)
    }
  }

  const folders = [...groups.values()]
    .map(folder => {
      folder.commands.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      folder.rows.sort((a, b) => {
        const ka = sortKeyFor(a, opts.mediaType)
        const kb = sortKeyFor(b, opts.mediaType)
        if (ka !== kb) return ka.localeCompare(kb)
        const ca = order.get(a.command) ?? 0
        const cb = order.get(b.command) ?? 0
        if (ca !== cb) return ca - cb
        if (a.type !== b.type) return a.type.localeCompare(b.type)
        return a.issue.localeCompare(b.issue)
      })
      return folder
    })
    .sort((a, b) => a.path.localeCompare(b.path))

  return {
    generated: new Date().toISOString(),
    drive: opts.drive,
    media_type: opts.mediaType,
    sources,
    count: folders.reduce((total, folder) => total + folder.count, 0),
    folder_count: folders.length,
    by_type: Object.fromEntries(
      Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    ),
    folders,
  }
}

/**
 * A row's ordering key: its relative path in canonical form, so the scan's
 * `Season 03` and the TMDB pass's `Season 3` land adjacent instead of a screen
 * apart. Folder-level rows (no path) sort first.
 *
 * Segment i of a relative path sits at level `2 + i` — the folder itself is
 * level 1 — which is what routes a shows season through the season fold.
 */
function sortKeyFor(row: MergedWarningRow, mediaType: IgnoreMediaType): string {
  if (row.path === undefined) return ''
  return row.path
    .split('/')
    .map((segment, i) => canonicalName(mediaType, 2 + i, segment))
    .join('/')
}
