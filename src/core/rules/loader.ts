/**
 * core/rules/loader.ts
 * --------------------
 * Three-tier rules loader. For each media type the loader merges, in order:
 *
 *   1. Code-shipped defaults — always the base layer
 *   2. `rules/<mediaType>.yaml` — committed snapshot of defaults, edited in
 *      place when you want to change the defaults for everyone using this
 *      checkout. Missing? Defaults still apply.
 *   3. `rules/<mediaType>.local.yaml` — gitignored personal overrides. This
 *      is where a user's library-specific settings (quality_thresholds,
 *      personal ignored_season_names, extra media folders) live.
 *
 * After merging, the result is validated by the Zod schema. Validation errors
 * print a readable message and exit — there's no value in scanning with
 * broken rules.
 */

import fs from 'fs'
import path from 'path'

import jsYaml from 'js-yaml'
import { ZodError, ZodType } from 'zod'

// ─────────────────────────────────────────────
// Deep merge
// ─────────────────────────────────────────────

/**
 * True for plain `{}` objects, false for arrays, null, primitives, Maps, etc.
 * We only recursively merge objects — arrays are replaced wholesale because
 * "extend the default acceptable_quality_combos" is rarely what the user means;
 * "override the whole list" is.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.constructor === Object
}

/**
 * Recursively merge `override` into `base`. Object keys deep-merge; everything
 * else (arrays, primitives) replaces. Returns a new object — neither input is mutated.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : (override as T)
  }
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overrideVal = override[key]
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal)
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal
    }
  }
  return result as T
}

// ─────────────────────────────────────────────
// Sentinel resolution
// ─────────────────────────────────────────────

/**
 * Replace the literal string "current" anywhere in the rules tree with the
 * current calendar year. Lets users write `max: current` in YAML without the
 * runtime code having to think about it.
 *
 * Recursive walk — works for any nesting depth, future-proofs us if other
 * rules pick up the same sentinel.
 */
function resolveSentinels<T>(value: T): T {
  if (value === 'current') return new Date().getFullYear() as unknown as T
  if (Array.isArray(value)) return value.map(resolveSentinels) as unknown as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveSentinels(v)
    return out as unknown as T
  }
  return value
}

// ─────────────────────────────────────────────
// YAML reader
// ─────────────────────────────────────────────

/**
 * Read and parse a YAML file. Returns the parsed object on success, `null`
 * if the file is empty or all-comments, exits the process on parse error.
 * Returns `undefined` when the file doesn't exist on disk (caller decides
 * whether that's expected).
 */
function readYamlIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined

  let parsed: unknown
  try {
    parsed = jsYaml.load(fs.readFileSync(filePath, 'utf-8'))
  } catch (err) {
    console.error(`\n  Error parsing ${filePath} as YAML:`)
    console.error(`    ${(err as Error).message}`)
    process.exit(1)
  }
  // A file consisting only of comments parses to null. Normalize that to
  // `undefined` so the caller treats it like "no overrides" rather than
  // emitting a useless merge.
  return parsed ?? undefined
}

// ─────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────

interface LoadRulesOptions<T> {
  /** Logical name used in error messages and the YAML filename, e.g. "movies" */
  mediaType: string
  /** Zod schema for the rules — also the source of the inferred TypeScript type */
  schema: ZodType<T>
  /** Code-shipped defaults — the base before any YAML files are merged */
  defaults: T
  /** Project root (where the rules/ folder lives) */
  projectRoot: string
}

/**
 * Load and validate rules for one media type.
 *
 * Merges in order: code defaults → `rules/<mediaType>.yaml` (committed,
 * usually mirrors defaults) → `rules/<mediaType>.local.yaml` (gitignored,
 * personal overrides). The final result is Zod-validated.
 *
 * Prints one boot-time log line per file actually loaded plus one final
 * summary so you can see at a glance which layers contributed.
 */
export function loadRules<T>(opts: LoadRulesOptions<T>): T {
  const { mediaType, schema, defaults, projectRoot } = opts
  const basePath = path.join(projectRoot, 'rules', `${mediaType}.yaml`)
  const localPath = path.join(projectRoot, 'rules', `${mediaType}.local.yaml`)

  let merged: unknown = defaults
  let localOverrideCount = 0

  // ── Tier 2: committed YAML (mirrors code defaults by default) ──────────
  const baseRules = readYamlIfExists(basePath)
  if (isPlainObject(baseRules) && Object.keys(baseRules).length > 0) {
    merged = deepMerge(merged, baseRules)
  }

  // ── Tier 3: gitignored personal overrides ──────────────────────────────
  const localRules = readYamlIfExists(localPath)
  if (isPlainObject(localRules) && Object.keys(localRules).length > 0) {
    localOverrideCount = Object.keys(localRules).length
    merged = deepMerge(merged, localRules)
  }

  // ── Boot-time logging ─────────────────────────────────────────────────
  // Distinguish each layer so users can see what's in play. The "base" file
  // usually mirrors defaults verbatim (so its override count is the full
  // field count); the "local" file is where real per-user changes live.
  if (baseRules === undefined && localRules === undefined) {
    console.log(`    [RULES] Using code defaults (no rules/${mediaType}.yaml found)`)
  } else if (localOverrideCount === 0) {
    console.log(`    [RULES] Loaded rules/${mediaType}.yaml (no local overrides)`)
  } else {
    console.log(
      `    [RULES] Loaded rules/${mediaType}.yaml + ${localOverrideCount} override(s) from rules/${mediaType}.local.yaml`
    )
  }
  // Resolve sentinels BEFORE validation so the schema sees their resolved form
  merged = resolveSentinels(merged)

  try {
    return schema.parse(merged)
  } catch (err) {
    if (err instanceof ZodError) {
      // We can't easily attribute each issue to base vs local without diffing
      // the merged result, so we report at the merged layer.
      const sources = [
        baseRules && `rules/${mediaType}.yaml`,
        localRules && `rules/${mediaType}.local.yaml`,
      ]
        .filter(Boolean)
        .join(' + ')
      const where = sources || 'code defaults'
      console.error(
        `\n  Error: rules for ${mediaType} failed schema validation (sources: ${where}):`
      )
      for (const issue of err.issues) {
        const at = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        console.error(`    - ${at}: ${issue.message}`)
      }
      process.exit(1)
    }
    throw err
  }
}
