/**
 * core/runner-shared.ts
 * ---------------------
 * Boilerplate shared by every CLI entry point (scan, validate, plex:check,
 * plex:logs, fix:shows).
 *
 * Each runner parses the same `--all | --type <value> | --help` argument
 * shape plus an optional trailing drive name, resolves that name against the
 * type's configured roots, prints the same header and summary, and writes
 * JSON output and warnings the same way. Keeping that logic in one place means
 * a behavior change ripples to every command without copy-paste.
 */

import { rootsFor } from './config'
import { writeFileAtomic } from './atomic-write'
import { MediaType } from './project'
import { AppConfig, MediaRootConfig, WarningCollector, WarningsOutput } from './types'

// ─────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────

/**
 * The result of parsing a runner's argv. Callers switch on `kind` to
 * dispatch — they decide whether `help` should exit cleanly or with
 * status 1 (help-on-no-args is conventionally an error for CLI scripts, but
 * `--help` explicitly is clean).
 *
 * `drive` is the optional positional root name (`npm run movies external`).
 * When undefined the runner falls back to the first root configured for the
 * type — see `resolveRoot()`.
 */
export type RunnerMode =
  | { kind: 'all'; drive?: string }
  | { kind: 'one'; type: string; drive?: string }
  | { kind: 'help'; explicit: boolean }

/**
 * Pull the optional drive name out of the remaining args — the first token
 * that isn't a flag. npm forwards bare positionals to the script, so
 * `npm run movies external` arrives here as `--type movies external`.
 */
function extractDrive(rest: string[]): string | undefined {
  return rest.find(arg => !arg.startsWith('--'))
}

/**
 * Parse `process.argv` for the runner's common flag shape.
 *
 * Exits the process with a clear error message when an invalid flag or
 * unknown `--type` value is passed. Returns a `RunnerMode` for valid input.
 *
 * `explicit` on the help mode is `true` when the user passed `--help`/`-h`
 * and `false` when they passed nothing — callers usually distinguish those
 * to set the exit status.
 */
export function parseRunnerArgs(validTypes: readonly string[]): RunnerMode {
  const args = process.argv.slice(2)
  const flag = args[0]
  const value = args[1]

  if (!flag) return { kind: 'help', explicit: false }

  if (flag === '--all') return { kind: 'all', drive: extractDrive(args.slice(1)) }
  if (flag === '--help' || flag === '-h') return { kind: 'help', explicit: true }

  if (flag === '--type') {
    if (!value || !validTypes.includes(value)) {
      console.error(`\n  Error: invalid type '${value ?? ''}'. Choices: ${validTypes.join(', ')}`)
      process.exit(1)
    }
    return { kind: 'one', type: value, drive: extractDrive(args.slice(2)) }
  }

  console.error(`\n  Error: unknown flag '${flag}'`)
  process.exit(1)
}

// ─────────────────────────────────────────────
// Root resolution
// ─────────────────────────────────────────────

/**
 * Pick which configured root a run targets.
 *
 *   - No `driveName` → the first root for that type (the documented default).
 *   - A `driveName` → the root whose `name` matches, case-insensitively.
 *   - No match → `null`, so the caller decides between erroring (a single-type
 *     run named a drive that doesn't exist) and skipping (`--all` across types
 *     where only some live on that drive).
 */
export function resolveRoot(
  roots: MediaRootConfig[],
  driveName: string | undefined
): MediaRootConfig | null {
  if (driveName === undefined) return roots[0] ?? null
  const target = driveName.toLowerCase()
  return roots.find(root => root.name.toLowerCase() === target) ?? null
}

/** The configured root names for a type, for use in error messages. */
export function rootNames(roots: MediaRootConfig[]): string {
  return roots.map(root => root.name).join(', ')
}

/**
 * Why no root could be picked for a type, or null when one can. Split out
 * from `selectRoot` so the wording is testable without exiting.
 */
export function rootProblem(
  config: AppConfig,
  mediaType: MediaType,
  driveName: string | undefined
): string | null {
  const roots = rootsFor(config, mediaType)
  if (roots.length === 0) return `${mediaType} isn't configured in config.json`
  if (resolveRoot(roots, driveName)) return null
  return `no root named '${driveName}' configured for ${mediaType} (have: ${rootNames(roots)})`
}

/**
 * Resolve the root a run targets, with the policy every command shares:
 * under `--all` a type with no matching root is skipped with a note, while a
 * single-type run treats it as an error — `scan:all external` shouldn't die
 * just because music lives on one drive, but `npm run music external` is a
 * typo worth surfacing.
 */
export function selectRoot(
  config: AppConfig,
  mediaType: MediaType,
  driveName: string | undefined,
  acrossAllTypes: boolean
): MediaRootConfig | null {
  const problem = rootProblem(config, mediaType, driveName)
  if (problem === null) return resolveRoot(rootsFor(config, mediaType), driveName)

  if (acrossAllTypes) {
    console.log(`\n  [SKIP] ${mediaType} — ${problem}`)
    return null
  }
  console.error(`\n  Error: ${problem}`)
  if (rootsFor(config, mediaType).length === 0) {
    console.error(`    Add a "${mediaType}" list to config.json — see config.example.json.`)
  }
  process.exit(1)
}

// ─────────────────────────────────────────────
// Console output
// ─────────────────────────────────────────────

const RULE = '─'.repeat(50)

/** The banner every command opens with, plus the drive when one is fixed. */
export function printBanner(title: string, root?: MediaRootConfig): void {
  console.log(`\n${RULE}`)
  console.log(`  MOASYS-Vault — ${title}`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log(RULE)
  if (root) {
    console.log(`\n  Drive: ${root.name}`)
    console.log(`  Root : ${root.root_path}`)
  }
  console.log()
}

/** `warn_a (3), warn_b (1)` — the per-type breakdown after a run. */
export function warningBreakdown(warnings: WarningCollector): string {
  return warnings
    .countByType()
    .map(({ type, count }) => `${type} (${count})`)
    .join(', ')
}

/**
 * The closing summary: totals, silenced count, per-type breakdown, and where
 * to look.
 *
 *   Done — 4496 entries, 3 warnings, 12 silenced via ignore list.
 *     warn_x (2), warn_y (1)
 *   → Review output/server/movies/warnings.json
 */
export function printRunSummary(
  warnings: WarningCollector,
  opts: {
    /** What's being counted, e.g. `warnings` or `validation warnings`. */
    noun: string
    /** Output file to point at, relative to the project root. */
    review: string
    /** Text before the warning count, e.g. `4496 entries, `. */
    lead?: string
    /** Text after the sentence, e.g. ` 14 TMDB requests.` */
    tail?: string
  }
): void {
  const silenced = warnings.silencedCount()
  const silencedSummary = silenced > 0 ? `, ${silenced} silenced via ignore list` : ''
  console.log(
    `\n  Done — ${opts.lead ?? ''}${warnings.count()} ${opts.noun}${silencedSummary}.${opts.tail ?? ''}`
  )
  if (warnings.count() > 0) {
    console.log(`    ${warningBreakdown(warnings)}`)
    console.log(`  → Review ${opts.review}`)
  }
}

// ─────────────────────────────────────────────
// Output writers
// ─────────────────────────────────────────────

/**
 * Write an arbitrary serializable object to disk as pretty-printed JSON.
 * Used by the probe and validate runners — the scan runner has its own
 * variant in `core/scanner.ts` that goes through the media module's
 * type-aware serializer first.
 *
 * Logs the file path and an item count for arrays. Creates the parent
 * directory if it doesn't already exist, and writes atomically.
 */
export function writeJsonOutput(outputPath: string, data: unknown): void {
  writeFileAtomic(outputPath, JSON.stringify(data, null, 2))
  const summary = Array.isArray(data) ? `  (${data.length} entries)` : ''
  console.log(`    [OUT] ${outputPath}${summary}`)
}

/**
 * Write a WarningCollector's contents to a warnings JSON file. Shape:
 * `{ generated, count, by_type }`. Used by every runner that emits warnings.
 * Arg order matches `writeJsonOutput` for consistency.
 */
export function writeWarnings(outputPath: string, warnings: WarningCollector): void {
  const out: WarningsOutput = {
    generated: new Date().toISOString(),
    count: warnings.count(),
    by_type: warnings.groupedByType(),
  }
  writeFileAtomic(outputPath, JSON.stringify(out, null, 2))
  console.log(`    [OUT] ${outputPath}  (${warnings.count()} warnings)`)
}
