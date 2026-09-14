/**
 * core/runner-shared.ts
 * ---------------------
 * Boilerplate shared by all three runner entry points (scan, probe, validate).
 *
 * Each runner parses the same `--all | --type <value> | --help` argument
 * shape plus an optional trailing drive name, resolves that name against the
 * type's configured roots, writes JSON output the same way, and writes
 * warnings the same way. Keeping that logic in one place means a behavior
 * change (e.g. adding a new --quiet flag) ripples to all three without
 * copy-paste.
 */

import fs from 'fs'
import path from 'path'

import { MediaRootConfig, WarningCollector, WarningsOutput } from './types'

// ─────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────

/**
 * The result of parsing a runner's argv. Callers switch on `mode` to
 * dispatch — they decide whether `help` should exit cleanly or with
 * status 1 (scan.ts uses 1; help-on-no-args is conventionally an error
 * for CLI scripts, but `--help` explicitly is clean).
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
 * directory if it doesn't already exist.
 */
export function writeJsonOutput(outputPath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8')
  const summary = Array.isArray(data) ? `  (${data.length} entries)` : ''
  console.log(`    [OUT] ${outputPath}${summary}`)
}

/**
 * Write a WarningCollector's contents to a warnings JSON file. Shape:
 * `{ generated, count, by_type }`. Used by the scan and validate runners.
 * Arg order matches `writeJsonOutput` for consistency.
 */
export function writeWarnings(outputPath: string, warnings: WarningCollector): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const out: WarningsOutput = {
    generated: new Date().toISOString(),
    count: warnings.count(),
    by_type: warnings.groupedByType(),
  }
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2), 'utf-8')
  console.log(`    [OUT] ${outputPath}  (${warnings.count()} warnings)`)
}
